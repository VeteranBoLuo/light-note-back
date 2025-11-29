import pool from '../db/index.js';
import { snakeCaseKeys, resultData, getClientIp, baseRouter } from './common.js';

const attackTypes = {
  // 注入类攻击
  SQL_INJECTION: {
    regex: /(\b(SELECT\s+.*FROM|UNION\s+SELECT|DELETE\s+FROM|DROP\s+TABLE|INSERT\s+INTO)\b)|(--\s+|\/\*.*\*\/)/i,
    // 可选：添加白名单，排除合法的字段名或值
    whitelist: ['pageSize', 'currentPage', 'level', 'filters', 'userId'],
  },
  COMMAND_INJECTION: /(\b(rm\s+-rf|wget\s+http|curl\s+http|exec$|spawn\()\b)/i,

  // 跨站脚本攻击
  XSS: {
    regex:
      /<\s*script\b[^>]*>([\s\S]*?)<\/\s*script\s*>|alert\(\s*['"]?[\s\S]*?['"]?\s*\)|javascript:\s*['"]?[\s\S]*?['"]?|on\w+\s*=\s*['"]?[\s\S]*?['"]?/i,
    whitelist: ['description', 'content', 'comment'], // 添加合法字段白名单
  },
  // 协议层攻击
  CSRF: /Referer:\s*(?!https?:\/\/yourdomain\.com)/i, // 检测Referer白名单
  SSRF: /(http:\/\/127\.0\.0\.1|http:\/\/192\.168\.|http:\/\/10\.)/i, // 检测内网地址

  // 路径遍历
  DIRECTORY_TRAVERSAL: /(\.\.\/|\.\.\\|%2e%2e\/)/i,

  // DDoS特征
  HTTP_FLOOD: {
    rateLimit: 100, // 单个IP每秒最大请求数
  },

  // 文件上传攻击
  FILE_UPLOAD: /\.(php|jsp|asp|sh|exe)$/i,

  // 其他攻击
  HEADER_INJECTION: /\r\n/, // HTTP头换行符注入
  JSON_HIJACKING: /^$\]\}'/, // JSON劫持前缀
};
// 1. SQL注入检测
const sqlInjectionCheck = (data) => {
  const str = JSON.stringify(data);
  // 检查是否包含SQL注入特征
  if (attackTypes.SQL_INJECTION.regex.test(str)) {
    // 检查是否在白名单中
    const keys = Object.keys(data).concat(Object.keys(query));
    if (!keys.some((key) => attackTypes.SQL_INJECTION.whitelist.includes(key))) {
      return true;
    }
  }
  return false;
};
// 2. XSS检测（参数和头部）
const xssCheck = (data) => {
  const str = JSON.stringify(data);
  // 检查是否包含XSS特征
  if (attackTypes.XSS.regex.test(str)) {
    // 检查是否在白名单中
    const keys = Object.keys(data);
    if (!keys.some((key) => attackTypes.XSS.whitelist.includes(key))) {
      return true;
    }
  }
  return false;
};

const detectAttack = (req) => {
  // 白名单
  if (req.headers['x-user-id'] === '453c9c95-9b2e-11ef-9d4d-84a93e80c16e') {
    return false;
  }

  const { method, path, body, headers, query } = req;
  let detectedType = null;

  // 1. SQL/命令注入检测（基于内容）
  if (sqlInjectionCheck(body) || sqlInjectionCheck(query)) {
    detectedType = 'SQL_INJECTION';
  } else if (attackTypes.COMMAND_INJECTION.test(JSON.stringify(body))) {
    detectedType = 'COMMAND_INJECTION';
  }

  // 2. XSS检测（参数和头部）
  if (xssCheck(body) || xssCheck(query) || xssCheck(headers)) {
    detectedType = 'XSS';
  }

  // 3. 路径遍历检测（URL路径）
  if (attackTypes.DIRECTORY_TRAVERSAL.test(path)) {
    detectedType = 'DIRECTORY_TRAVERSAL';
  }

  // 5. SSRF检测（请求参数含内网地址）
  if (attackTypes.SSRF.test(JSON.stringify(body))) {
    detectedType = 'SSRF';
  }

  // 6. 文件上传检测（文件类型黑名单）
  if (req.files) {
    req.files.forEach((file) => {
      if (attackTypes.FILE_UPLOAD.test(file.originalname)) {
        detectedType = 'FILE_UPLOAD';
      }
    });
  }
  const allowApi = [];
  baseRouter.forEach((Router) => {
    Object.keys(Router.router.stack).forEach((key) => {
      const route = Router.router.stack[key];
      if (route.route) {
        allowApi.push(Router.path + route.route.path);
      }
    });
  });
  const illegalApi = allowApi.some((url) => {
    return (
      path.startsWith(url) ||
      path.startsWith('/uploads') ||
      path.startsWith('/files') ||
      path === '/' ||
      path === '/favicon.ico'
    );
  });
  if (detectedType || !illegalApi) {
    const log = {
      attack_type: detectedType || '非法请求地址',
      request_method: method,
      request_path: path,
      source_ip: getClientIp(req),
      payload: JSON.stringify({ ...body, ...query }),
      user_agent: headers['user-agent'],
      created_at: req.requestTime,
    };
    pool
      .query('INSERT INTO attack_logs SET ?', [log])
      .catch((err) => console.error('攻击日志更新错误: ' + err.message));
  }
  return detectedType;
};

export async function logFunction(req, res, next) {
  try {
    const noPass = detectAttack(req, res, next);
    if (noPass) {
      return res.status(403).json({ code: 403, msg: '系统检测为非法请求' });
    }
    // 角色为游客，需要查询获取
    if (!req.headers['x-user-id'] && req.headers.role === 'visitor') {
      const [visitorResult] = await pool.query('SELECT id FROM user WHERE role = ?', ['visitor']);
      req.headers['x-user-id'] = visitorResult[0].id;
    } else {
      if (req.originalUrl.includes('login')) {
        // 登录接口调用时还没有userID和角色权限等信息，需要查询获取
        const { email, password } = req.body;
        const [userResult] = await pool.query('SELECT * FROM user WHERE email = ? AND password = ?', [
          email,
          password,
        ]);
        if (!userResult[0]) {
          throw new Error('邮箱或密码错误');
        }
        if (userResult[0].del_flag === '1') {
          throw new Error('账号已被禁用');
        }
      } else {
        const [userResult] = await pool.query('SELECT * FROM user WHERE id = ?', [req.headers['x-user-id']]);
        // 用户删除或不存在则使用游客账号
        if (!userResult[0] || userResult[0].del_flag === '1') {
          const [visitorResult] = await pool.query('SELECT id FROM user WHERE role = ?', ['visitor']);
          req.headers['x-user-id'] = visitorResult[0].id;
        }
      }
    }
    const userId = req.headers['x-user-id'];
    let skipUser = false;
    if (userId) {
      skipUser = ['453c9c95-9b2e-11ef-9d4d-84a93e80c16e'].some((key) => userId.includes(key));
    }
    // 跳过不记录的接口
    const skipApi = ['Logs', 'getUserInfo', 'getUserList', 'analyzeImgUrl', 'getRelatedTag'].some((key) =>
      req.originalUrl.includes(key),
    );

    if (skipApi || skipUser) {
      next();
      return;
    }
    const requestPayload = JSON.stringify(req.method === 'GET' ? req.query : req.body);
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
    res.on('finish', async () => {
      if (userId) {
        try {
          const [locations] = await pool.query('SELECT location FROM user WHERE id = ?', [userId]);
          const location = locations[0].location ?? '未知';
          const system = JSON.stringify({
            browser: req.headers['browser'] ?? '未知',
            os: req.headers['os'] ?? '未知',
            fingerprint: req.headers['fingerprint'],
          });
          // 构造日志对象
          const log = {
            userId: userId,
            method: req.method,
            url: req.originalUrl,
            req: requestPayload === '{}' ? '' : requestPayload,
            ip: getClientIp(req) || '',
            location: location,
            system: system,
            requestTime: req.requestTime, // 获取当前时间
            del_flag: 0,
          };
          // 将日志保存到数据库
          const query = 'INSERT INTO api_logs SET ?';
          pool.query(query, [snakeCaseKeys(log)]).catch((err) => {
            console.error('日志更新sql错误: ' + err.message);
          });
        } catch (err1) {
          console.error('日志更新错误：', err1);
        }
      }
    });
    next();
  } catch (e) {
    res.send(resultData(null, 500, e.message)); // 设置状态码为500
  }
}
