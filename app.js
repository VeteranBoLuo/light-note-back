const express = require('express');
const userRouter = require('./router/user');
const commonRouter = require('./router/common');
const noteLibraryRouter = require('./router/noteLibrary');
const bookmarkRouter = require('./router/bookmark');
const opinionRouter = require('./router/opinion');
const bodyParser = require('body-parser');
const { logFunction } = require('./util/log');
const { requestTime, getClientIp } = require('./util/common');
const pool = require('./db/index');

// 建立一个Express服务器
const app = express();
app.use(bodyParser.json({ limit: '10mb', extended: true }));
//  解析请求体中的JSON数据
app.use(express.json());

//  记录请求时间
app.use(requestTime);
app.use((req, res, next) => {
  const { method, path, body, headers, query } = req;
  const allowedOrigins = ['http://localhost:5173', 'https://boluo66.top', 'http://boluo66.top'];
  const origin = req.headers.origin || req.headers.referer;
  if (!allowedOrigins.some((url) => origin?.startsWith(url))) {
    // 记录攻击事件
    const log = {
      attack_type: '非法请求来源',
      request_method: method,
      request_path: path,
      source_ip: getClientIp(req),
      payload: JSON.stringify({ ...body, ...query }),
      user_agent: headers['user-agent'],
      created_at: req.requestTime,
    };
    // 将攻击日志保存到数据库
    pool.query('INSERT INTO attack_logs SET ?', [log]).catch((err) => {
      console.error('攻击日志更新错误: ' + err.message);
    });
    return res.status(403).json({ code: 403, msg: '非法请求来源' });
  }
  next();
});
// 日志记录中间件
app.use(logFunction);

app.use('/user', userRouter);
app.use('/common', commonRouter);
app.use('/note', noteLibraryRouter);
app.use('/bookmark', bookmarkRouter);
app.use('/opinion', opinionRouter);
// 设置静态文件目录
app.use('/uploads', express.static('/www/wwwroot/images'));
// 启动 Express 服务器
app.listen(9001, () => {
  console.log('服务器已启动——端口：9001');
});
