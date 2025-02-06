const pool = require('../db');
const fs = require('fs');
const path = require('path');
const { snakeCaseKeys, resultData, mergeExistingProperties } = require('../util/common');
exports.addNote = (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const params = {
      ...req.body,
      createBy: userId,
      createTime: req.requestTime,
    };
    pool
      .query('INSERT INTO note SET ?', [snakeCaseKeys(params)])
      .then(() => {
        pool
          .query('SELECT id FROM note ORDER BY create_time DESC LIMIT 1')
          .then(([noteRes]) => {
            res.send(
              resultData({
                id: noteRes[0]['id'],
              }),
            );
          })
          .catch((err) => {
            res.send(resultData(null, 500, '服务器内部错误: ' + err.message)); // 设置状态码为500
          });
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误: ' + err.message)); // 设置状态码为500
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e)); // 设置状态码为400
  }
};
exports.updateNote = (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const params = {
      ...req.body,
      updateBy: userId,
      updateTime: req.requestTime,
    };
    pool
      .query('update note set ? where id=?', [snakeCaseKeys(mergeExistingProperties(params, [], ['id'])), req.body.id])
      .then(() => {
        res.send(resultData('更新笔记成功'));
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误: ' + err.message)); // 设置状态码为500
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e)); // 设置状态码为400
  }
};
exports.queryNoteList = (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    pool
      .query('select * from note where create_by=? and del_flag=0', [userId])
      .then(([result]) => {
        res.send(resultData(result));
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误: ' + err.message)); // 设置状态码为500
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e)); // 设置状态码为400
  }
};
exports.getNoteDetail = (req, res) => {
  try {
    pool
      .query('select * from note where id=?', [req.body.id])
      .then(([result]) => {
        res.send(resultData(result[0]));
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误: ' + err.message)); // 设置状态码为500
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e)); // 设置状态码为400
  }
};

exports.delNote = async (req, res) => {
  try {
    const id = req.body.id; // 获取标签ID
    let sql = `UPDATE note SET del_flag=1  WHERE id=?`;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction(); // 开始事务
      pool
        .query(sql, [id])
        .then(async ([result]) => {
          // 查询关联的图片URLs
          const selectImagesSql = `SELECT url FROM note_images WHERE note_id = ?`;
          const [images] = await connection.query(selectImagesSql, [id]);

          // 删除笔记关联的图片记录
          const deleteAssociationsSql = `DELETE FROM note_images WHERE note_id = ?`;
          await connection.query(deleteAssociationsSql, [id]);

          await connection.commit(); // 提交事务

          // 删除服务器上的图片文件
          const deletePromises = images.map((image) => {
            // 替换URL中的代理路径为实际文件路径
            const filePath = image.url.replace('/uploads/', '/www/wwwroot/images/');
            return fs.unlink(path.join(__dirname, '..', filePath));
          });

          // 等待所有文件删除操作完成
          await Promise.all(deletePromises);

          res.send(resultData(result));
        })
        .catch((e) => {
          return res.send(resultData(null, 500, '服务器内部错误: ' + e));
        });
    } catch (error) {
      await connection.rollback(); // 回滚事务
      res.send(resultData(null, 500, '服务器内部错误: ' + error.message)); // 设置状态码为500
    } finally {
      connection.release(); // 释放连接
    }
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e)); // 设置状态码为400
  }
};
