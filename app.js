const express = require('express');
const userRouter = require('./router/user');
const commonRouter = require('./router/common');
const noteLibraryRouter = require('./router/noteLibrary');
const bookmarkRouter = require('./router/bookmark');
const opinionRouter = require('./router/opinion');
const bodyParser = require('body-parser');
const { logFunction } = require('./util/log');
const { requestTime } = require('./util/common');

// 建立一个Express服务器
const app = express();
app.use(bodyParser.json({ limit: '10mb', extended: true }));
//  解析请求体中的JSON数据
app.use(express.json());
//  记录请求时间
app.use(requestTime);
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
