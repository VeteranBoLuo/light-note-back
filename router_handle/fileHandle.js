const pool = require('../db');
const { resultData, snakeCaseKeys } = require('../util/common');
const fs = require('fs');
const path = require('path');
// 修改文件（名字）同时修改服务器上的本地文件的名字
exports.updateFile = async (req, res) => {
  try {
    const { id, fileName } = req.body;

    // 查询文件信息
    const sql = 'SELECT * FROM files WHERE id = ?';
    const [results] = await pool.query(sql, [id]);

    if (results.length === 0) {
      return res.send(resultData(null, 404, '数据库中未找到文件'));
    }

    const file = results[0];
    const filePath = path.join('/www/wwwroot/files', file.file_name);

    // 检查文件是否存在
    fs.access(filePath, fs.constants.F_OK, async (err) => {
      if (err) {
        return res.send(resultData(null, 404, '服务器上文件不存在'));
      }

      // 获取原始文件后缀名 [5](@ref)
      const originalExt = path.extname(file.file_name);

      // 检查用户提供的新文件名是否包含后缀 [3,5](@ref)
      const newExt = path.extname(fileName);
      let finalFileName = fileName;

      // 如果用户输入的文件名没有后缀，自动添加原始后缀 [5,6](@ref)
      if (!newExt) {
        finalFileName = fileName + originalExt;
      }
      // 如果用户输入了后缀但与原后缀不同，保留用户输入（允许修改文件类型）
      else if (newExt !== originalExt) {
        finalFileName = fileName;
      }

      // 检查文件名安全性（防止路径遍历攻击）[3](@ref)
      if (
        finalFileName.includes('/') ||
        finalFileName.includes('\\') ||
        finalFileName.includes('>') ||
        finalFileName.includes('<')
      ) {
        return res.send(resultData(null, 400, '文件名不能包含特殊字符或路径分隔符'));
      }

      // 修改数据库中的文件记录
      const updateSql = 'UPDATE files SET file_name = ? WHERE id = ?';
      await pool.query(updateSql, [finalFileName, id]);

      // 修改服务器上的文件名
      const newFilePath = path.join('/www/wwwroot/files', finalFileName);
      fs.renameSync(filePath, newFilePath);

      res.send(resultData({ id, fileName: finalFileName }));
    });
  } catch (e) {
    console.error('修改文件名时出错:', e);
    res.send(resultData(null, 500, '服务器内部错误: ' + e.message));
  }
};

exports.queryFolder = async (req, res) => {
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
    query += ` ORDER BY create_time DESC`;

    const [result] = await connection.query(query, params);
    res.send(resultData({ items: result, total: result.length }, 200));
  } catch (e) {
    res.send(resultData(null, 500, `服务器内部错误: ${e.message}`));
  } finally {
    connection.release();
  }
};

exports.addFolder = async (req, res) => {
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
exports.associateFile = async (req, res) => {
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
exports.deleteFolder = async (req, res) => {
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
exports.updateFolder = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { id, name } = req.body;
    const [result] = await connection.query(`UPDATE folders SET name = ? WHERE id = ?`, [name, id]);
    res.send(resultData(result.affectedRows, 200, '修改成功'));
  } catch (e) {
    res.send(resultData(null, 500, '服务器内部错误: ' + e.message));
  }
};
