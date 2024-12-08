const userRouter = require("./router/user");
const commonRouter = require("./router/common");
const documentRouter = require("./router/document");
const bookmarkRouter = require("./router/bookmark");
const bodyParser = require("body-parser");

// 建立一个Express服务器
const express = require("express");
const pool = require("./db");
const { getCurrentTimeFormatted, snakeCaseKeys } = require("./util/result");
const app = express();
app.use(bodyParser.json({ limit: "10mb", extended: true }));
// 缓存中间件，为所有响应设置Cache-Control头
// app.use((req, res, next) => {
//     res.set('Cache-Control', 'public, max-age=3600'); // 缓存1小时
//     next();
// });

//  解析请求体中的JSON数据
app.use(express.json());
// 日志记录中间件
app.use(async (req, res, next) => {
  const userId = req.headers["x-user-id"];
  let skipUser = false;
  if (userId) {
    skipUser = ["453c9c95-9b2e-11ef-9d4d-84a93e80c16e"].some((key) =>
      userId.includes(key),
    );
  }
  const skipApi = [
    "Logs",
    "getUserInfo",
    "getUserList",
    "analyzeImgUrl",
    "getRelatedTag",
  ].some((key) => req.originalUrl.includes(key));

  if (skipApi || skipUser) {
    next();
    return;
  }
  const requestPayload = JSON.stringify(
    req.method === "GET" ? req.query : req.body,
  );
  // 创建一个变量来存储响应体
  let responsePayload;
  // 捕获原始响应发送函数
  const originalSend = res.send;
  // 重写 send 函数来捕获响应体
  res.send = function (body) {
    responsePayload = body;
    originalSend.call(this, body);
  };
  // 等待响应结束
  res.on("finish", async () => {
    const userId = req.headers["x-user-id"];
    // 调用登录注册接口时，没有userID，只有通过响应体判断
    if (
      userId ||
      (responsePayload && JSON.parse(responsePayload)?.status === 200)
    ) {
      try {
        // 查询用户信息
        const id = userId ? userId : JSON.parse(responsePayload)?.data?.id;
        const [result] = await pool.query("SELECT * FROM user WHERE id = ?", [
          id,
        ]);
        // 构造日志对象
        const log = {
          userId: id,
          userName: result[0]?.user_name,
          method: req.method,
          url: req.originalUrl,
          req: requestPayload === "{}" ? "" : requestPayload,
          res: responsePayload,
          os: req.headers.os,
          browser: req.headers["browser"],
          requestTime: getCurrentTimeFormatted(), // 获取当前时间
          del_flag: 0,
        };
        // 将日志保存到数据库
        const query = "INSERT INTO api_logs SET ?";
        pool.query(query, [snakeCaseKeys(log)]).catch((err) => {
          console.error("日志更新错误错误: " + err.message);
        });
      } catch (err1) {
        console.error("日志更新错误错误：", err1);
      }
    }
  });
  next();
});

app.use("/user", userRouter);
app.use("/common", commonRouter);
app.use("/document", documentRouter);
app.use("/bookmark", bookmarkRouter);

//  启动服务器
app.listen(9001, () => {
  console.log("服务器已启动，监听端口9001");
});
