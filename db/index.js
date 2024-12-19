// 引入mysql模块
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  connectionLimit: 10, // 例如限制为10个连接
  host: "127.0.0.1",
  port: 3306,
  user: "boluo",
  password: "123456",
  database: "tag_db",
  namedPlaceholders: true,
});

pool.getConnection((err, connection) => {
  if (err) {
    if (err.code === "PROTOCOL_CONNECTION_LOST") {
      console.error("Database connection was closed.");
    }
    if (err.code === "ER_CON_COUNT_ERROR") {
      console.error("Database has too many connections.");
    }
    if (err.code === "ECONNREFUSED") {
      console.error("Database connection was refused.");
    }
  }
  if (connection) connection.release();
  return;
});

module.exports = pool;
