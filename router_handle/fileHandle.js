import path from 'path';
import pool from '../db/index.js';
import { resultData, snakeCaseKeys } from '../util/common.js';
import { bucketBaseUrl, buildObjectKey, copyObjectInObs, deleteObjectFromObs } from '../util/obsClient.js';

export const updateFile = async (req, res) => {
  try {
    const { id, fileName } = req.body;

    // 查询文件信息
    const sql = 'SELECT * FROM files WHERE id = ?';
    const [results] = await pool.query(sql, [id]);

    if (results.length === 0) {
      return res.send(resultData(null, 404, '数据库中未找到文件'));
    }

    const file = results[0];

    const originalExt = path.extname(file.file_name);
    const newExt = path.extname(fileName);
    let finalFileName = fileName;

    if (!newExt) {
      finalFileName = fileName + originalExt;
    } else if (newExt !== originalExt) {
      finalFileName = fileName;
    }

    if (
      finalFileName.includes('/') ||
      finalFileName.includes('\\') ||
      finalFileName.includes('>') ||
      finalFileName.includes('<')
    ) {
      return res.send(resultData(null, 400, '文件名不能包含特殊字符或路径分隔符'));
    }

    const sourceKey = file.obs_key || buildObjectKey(file.create_by, file.file_name);
    const targetKey = buildObjectKey(file.create_by, finalFileName);

    try {
      await copyObjectInObs(sourceKey, targetKey);
      await deleteObjectFromObs(sourceKey);
    } catch (obsError) {
      console.error('OBS 重命名失败:', obsError);
      return res.send(resultData(null, 500, 'OBS 文件重命名失败: ' + obsError.message));
    }

    const updateSql = 'UPDATE files SET file_name = ?, obs_key = ?, directory = ? WHERE id = ?';
    await pool.query(updateSql, [finalFileName, targetKey, `${bucketBaseUrl}/${file.create_by}/`, id]);

    res.send(resultData({ id, fileName: finalFileName }));
  } catch (e) {
    console.error('修改文件名时出错:', e);
    res.send(resultData(null, 500, '服务器内部错误: ' + e.message));
  }
};

export const queryFolder = async (req, res) => {
  const { filters } = req.body;
  const connection = await pool.getConnection();

  try {
    const userId = req.headers['x-user-id'];
    const params = [userId];
    // 获取用户ID
    let query = `SELECT * FROM folders`;
    let whereClauses = ['create_by = ?'];

    const key = filters?.name?.trim() || '';

    // 可选的模糊查询
    if (key.length > 0) {
      whereClauses.push(`name LIKE CONCAT('%', ?, '%')`);
      params.push(key);
    }

    // 强制添加 del_flag = 0
    whereClauses.push(`del_flag = 0`);

    // 动态构建 WHERE 条件
    if (whereClauses.length > 0) {
      query += ` WHERE ` + whereClauses.join(' AND ');
    }

    // 固定排序
    query += ` ORDER BY sort, create_time DESC`;

    const [result] = await connection.query(query, params);
    res.send(resultData({ items: result, total: result.length }, 200));
  } catch (e) {
    res.send(resultData(null, 500, `服务器内部错误: ${e.message}`));
  } finally {
    connection.release();
  }
};

export const addFolder = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { name } = req.body;
    const createBy = req.headers['x-user-id'];
    const folder = {
      name: name,
      createBy,
      createTime: req.requestTime,
      del_flag: 0,
    };
    const [result] = await connection.query(`INSERT INTO folders SET ?`, [snakeCaseKeys(folder)]);
    res.send(resultData(result.insertId, 200, '新增文件夹成功'));
  } catch (e) {
    res.send(resultData(null, 500, '服务器内部错误: ' + e.message));
  }
};

// 文件关联文件夹
export const associateFile = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    let { folderId, fileId } = req.body;
    if (!folderId) {
      folderId = null;
    }
    const [result] = await connection.query(`UPDATE files SET folder_id = ? WHERE id = ?`, [folderId, fileId]);
    res.send(resultData(result.affectedRows, 200, '关联成功'));
  } catch (e) {
    res.send(resultData(null, 500, '服务器内部错误: ' + e.message));
  }
};

// 删除文件夹
export const deleteFolder = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.body;
    const [result] = await connection.query(`UPDATE folders SET del_flag = 1 WHERE id = ?`, [id]);
    res.send(resultData(result.affectedRows, 200, '删除成功'));
  } catch (e) {
    res.send(resultData(null, 500, '服务器内部错误: ' + e.message));
  }
};

// 修改文件夹名称
export const updateFolder = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { id, name } = req.body;
    const [result] = await connection.query(`UPDATE folders SET name = ? WHERE id = ?`, [name, id]);
    res.send(resultData(result.affectedRows, 200, '修改成功'));
  } catch (e) {
    res.send(resultData(null, 500, '服务器内部错误: ' + e.message));
  }
};

export const updateFolderSort = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction(); // 开始事务
    const { tags } = req.body;
    for (const tag of tags) {
      const { id, sort } = tag;
      const sql = 'UPDATE folders SET sort = ? WHERE id = ?';
      await pool.query(sql, [sort, id]);
    }
    await connection.commit(); // 提交事务
    res.send(resultData(null, 200, 'Sort updated successfully'));
  } catch (e) {
    await connection.rollback(); // 如果发生错误，回滚事务
    res.send(resultData(null, 500, '服务器内部错误' + e)); // 设置状态码为400
  } finally {
    connection.release(); // 释放连接回连接池
  }
};
