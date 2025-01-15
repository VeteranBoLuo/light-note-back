const pool = require('../db');
const { snakeCaseKeys, resultData } = require('../util/common');
exports.recordOpinion = async (req, res) => {
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
    // 如果发生错误，发送错误响应给前端
    res.send(resultData(null, 400, '客户端请求异常: ' + err.message));
  } finally {
    connection.release(); // 释放连接
  }
};

exports.getOpinionList = async (req, res) => {
  const connection = await pool.getConnection();
  const { pageSize, currentPage } = req.body;
  const skip = pageSize * (currentPage - 1);
  try {
    pool
      .query(
        'SELECT o.*,u.user_name FROM  opinion o  left join user u on o.user_id=u.id where  O.del_flag=0 LIMIT ? OFFSET ?',
        [pageSize, skip],
      )
      .then(async ([result]) => {
        const [totalRes] = await pool.query('SELECT COUNT(*) FROM opinion where  del_flag=0');
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
    // 如果发生错误，发送错误响应给前端
    res.send(resultData(null, 500, '客户端请求异常: ' + err.message));
  } finally {
    connection.release(); // 释放连接
  }
};

exports.delOpinion = (req, res) => {
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
