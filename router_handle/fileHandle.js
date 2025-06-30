const pool = require('../db');
const { resultData, snakeCaseKeys } = require('../util/common');
exports.queryFolder = async (req, res) => {
  const { filters } = req.body;
  const connection = await pool.getConnection();

  try {
    const params = [];
    let query = `SELECT * FROM folders`;
    let whereClauses = [];

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
    const { folderId, fileId } = req.body;
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
