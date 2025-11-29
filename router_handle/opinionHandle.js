import pool from '../db/index.js';
import { snakeCaseKeys, resultData } from '../util/common.js';

export const recordOpinion = async (req, res) => {
  const connection = await pool.getConnection();
  const userId = req.headers['x-user-id'];
  const insertSql = 'INSERT INTO opinion SET ?';
  const params = req.body;
  params.userId = userId;
  params.createTime = req.requestTime;
  try {
    pool
      .query(insertSql, [snakeCaseKeys(params)])
      .then(() => {
        res.send(resultData('反馈成功'));
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误: ' + err.message));
      });
  } catch (err) {
    res.send(resultData(null, 400, '客户端请求异常: ' + err.message));
  } finally {
    connection.release();
  }
};

export const getOpinionList = async (req, res) => {
  const connection = await pool.getConnection();
  const { pageSize, currentPage, userId } = req.body;
  const skip = pageSize * (currentPage - 1);

  try {
    let query = 'SELECT o.*, u.alias FROM opinion o LEFT JOIN user u ON o.user_id = u.id WHERE o.del_flag = 0';
    const params = [];

    if (userId !== undefined) {
      query += ' AND o.user_id = ?';
      params.push(userId);
    }

    query += ' ORDER BY create_time DESC LIMIT ? OFFSET ? ';
    params.push(pageSize, skip);
    pool
      .query(query, params)
      .then(async ([result]) => {
        let totalQuery = 'SELECT COUNT(*) FROM opinion WHERE del_flag = 0';
        const totalParams = [];

        if (userId !== undefined) {
          totalQuery += ' AND user_id = ?';
          totalParams.push(userId);
        }

        const [totalRes] = await pool.query(totalQuery, totalParams);
        res.send(
          resultData({
            items: result,
            total: totalRes[0]['COUNT(*)'],
          }),
        );
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误: ' + err.message));
      });
  } catch (err) {
    res.send(resultData(null, 500, '客户端请求异常: ' + err.message));
  } finally {
    connection.release();
  }
};

export const delOpinion = (req, res) => {
  try {
    const id = req.body.id; // 获取标签ID
    let sql = `UPDATE opinion SET del_flag=1  WHERE id=?`;
    pool
      .query(sql, [id])
      .then(([result]) => {
        res.send(resultData(result));
      })
      .catch((e) => {
        return res.send(resultData(null, 500, '服务器内部错误: ' + e));
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e)); // 设置状态码为400
  }
};
