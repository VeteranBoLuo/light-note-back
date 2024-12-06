const con = require("../db");
const {
  resultData,
  convertISOToDatabaseFormat,
  getCurrentTimeFormatted,
} = require("../util/result");
const userHandle = require("./userHandle");
// 用户操作日志
exports.saveDocument = (req, res) => {
  const userId = req.headers["x-user-id"];
  const { filters } = req.body;
  let sql = "update document set ? where id=?";
  let params = [
    {
      ...filters,
      updateBy: userId,
      updateTime: getCurrentTimeFormatted(),
    },
    filters.id,
  ];
  if (!filters.id) {
    sql = "INSERT INTO document SET ?";
    params = {
      ...filters,
      createBy: userId,
      createTime: getCurrentTimeFormatted(),
    };
  }
  console.log(params);
  try {
    con.query(sql, params, function (err, result) {
      if (err) {
        res.send(resultData(null, 500, "服务器内部错误" + err)); // 设置状态码为500
        return;
      }
      res.send(resultData(result));
    });
  } catch (e) {
    res.send(resultData(null, 400, "客户端请求异常" + e));
  }
};
exports.queryDocumentList = (req, res) => {
  try {
    con.query(`SELECT * FROM document ORDER BY createTime DESC`, null, function (err, result) {
      if (err) {
        res.send(resultData(null, 500, "服务器内部错误" + err)); // 设置状态码为500
        return;
      }
      const countQuery = `SELECT COUNT(*) AS total FROM handle_logs`;
      // 然后执行总数据条数查询
      con.query(countQuery, function (err, countResult) {
        if (err) {
          res.send(resultData(null, 500, err)); // 设置状态码为500
          return;
        }
        // 将分页数据和总数据条数合并后返回
        res.send(
          resultData({
            items: result,
            total: countResult[0].total,
          }),
        );
      });
    });
  } catch (e) {
    res.send(resultData(null, 400, "客户端请求异常" + e)); // 设置状态码为400
  }
};
exports.getDocumentDetail = (req, res) => {
  const { id } = req.body.filters;
  try {
    con.query(
      `SELECT * FROM document  where id =?`,
      id,
      function (err, result) {
        if (err) {
          res.send(resultData(null, 500, "服务器内部错误" + err)); // 设置状态码为500
          return;
        }
        // 然后执行总数据条数查询
        if (err) {
          res.send(resultData(null, 500, err)); // 设置状态码为500
          return;
        }
        // 将分页数据和总数据条数合并后返回
        res.send(
          resultData({
            items: result,
            total: result.length,
          }),
        );
      },
    );
  } catch (e) {
    res.send(resultData(null, 400, "客户端请求异常" + e)); // 设置状态码为400
  }
};
exports.delDocument = (req, res) => {
  const { id } = req.body.filters;
  try {
    con.query(`DELETE FROM document  where id =?`, id, function (err, result) {
      if (err) {
        res.send(resultData(null, 500, "服务器内部错误" + err)); // 设置状态码为500
        return;
      }
      // 将分页数据和总数据条数合并后返回
      res.send(resultData({}));
    });
  } catch (e) {
    res.send(resultData(null, 400, "客户端请求异常" + e)); // 设置状态码为400
  }
};
