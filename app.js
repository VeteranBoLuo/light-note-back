const express = require('express');
const userRouter = require('./router/user');
const commonRouter = require('./router/common');
const noteLibraryRouter = require('./router/noteLibrary');
const bookmarkRouter = require('./router/bookmark');
const opinionRouter = require('./router/opinion');
const fileRouter = require('./router/file');
const bodyParser = require('body-parser');
const { logFunction } = require('./util/log');
const { requestTime, getClientIp } = require('./util/common');
require('./db/index');
const dotenv = require('dotenv');
const path = require('path');
const mode = process.env.NODE_ENV || 'development';

// 根据 NODE_ENV 加载对应的 .env 文件
const envPath = path.resolve(__dirname, `.env.${mode}`);

dotenv.config({ path: envPath });
// 打印当前加载的环境变量（可选）
console.log(`Running in ${mode} mode`);
console.log(`Loaded env from: ${envPath}`);
console.log('BASE_URL:', process.env.BASE_URL);
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
    path: '/file',
    router: fileRouter,
  },
  {
    path: '/files',
    router: express.static('/www/wwwroot/files'), // 设置静态文件目录,
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
  console.log('服务器已启动' + new Date());
});
