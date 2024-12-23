// 引入mysql模块
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  connectionLimit: 10, // 例如限制为10个连接
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: '123456',
  database: 'tag_db',
  namedPlaceholders: true,
});

pool
  .getConnection()
  .then((connection) => {
    // 完成后释放连接
    connection.release();
  })
  .catch((err) => {
    if (err.code === 'PROTOCOL_CONNECTION_LOST') {
      console.error('Database connection was closed.');
    } else if (err.code === 'ER_CON_COUNT_ERROR') {
      console.error('Database has too many connections.');
    } else if (err.code === 'ECONNREFUSED') {
      console.error('Database connection was refused.');
    } else {
      console.error(err.message);
    }
  });

module.exports = pool;
