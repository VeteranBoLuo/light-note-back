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
// 日志记录中间件
app.use(logFunction);

const allRouter = [
  {
    path: '/user',
    router: userRouter,
  },
  {
    path: '/common',
    router: commonRouter,
  },
  {
    path: '/note',
    router: noteLibraryRouter,
  },
  {
    path: '/bookmark',
    router: bookmarkRouter,
  },
  {
    path: '/opinion',
    router: opinionRouter,
  },
  {
    path: '/uploads',
    router: express.static('/www/wwwroot/images'), // 设置静态文件目录
  },
];
allRouter.forEach((item) => {
  app.use(item.path, item.router);
});
// 启动 Express 服务器
app.listen(9001, () => {
  console.log('服务器已启动');
});
