import express from 'express';
import bodyParser from 'body-parser';
import { logFunction } from './util/log.js';
import { baseRouter, requestTime } from './util/common.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import './db/index.js';

// 获取 __dirname 的 ES 模块等效写法
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 判断是否是生产环境（比如：运行在 Linux 上）
function isProduction() {
  return process.platform === 'linux';
}
// 设置 mode
const mode = isProduction() ? 'production' : 'development';
// 根据 NODE_ENV 加载对应的 .env 文件
const envPath = path.resolve(__dirname, `.env.${mode}`);

dotenv.config({ path: envPath });
// 打印当前加载的环境变量（可选）
console.log(`Running in 【${mode}】 mode`);
console.log(`Loaded env from: 【${envPath}】`);
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
  ...baseRouter,
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
  console.log('环境变量:', process.env);

  console.log('服务器已启动：' + new Date().toLocaleString('zh-CN'));
});
