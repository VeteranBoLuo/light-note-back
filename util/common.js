import '../db/index.js';
import userRouter from '../router/user.js';
import commonRouter from '../router/common.js';
import noteLibraryRouter from '../router/noteLibrary.js';
import bookmarkRouter from '../router/bookmark.js';
import opinionRouter from '../router/opinion.js';
import fileRouter from '../router/file.js';
import chatRouter from '../router/chat.js';
import jsonRouter from '../router/json.js';

export const resultData = function (data = null, status = 200, msg = '') {
  if (status !== 200 && status !== 'visitor') {
    console.error(status, msg);
  }
  return {
    data: camelCaseKeys(data),
    status: status,
    msg: msg,
  };
};

// 下划线转驼峰
const camelCaseKeys = function (input) {
  // 定义一个处理函数，用于将单个对象中的键转换为驼峰命名
  function toCamelCase(obj) {
    if (Array.isArray(obj)) {
      // 如果是数组，递归映射每个元素到处理函数
      return obj.map(toCamelCase);
    } else if (typeof obj === 'object' && obj !== null) {
      // 如果是对象，递归处理每个属性
      const result = {};
      for (let key in obj) {
        // 递归处理对象的值
        const value = toCamelCase(obj[key]);
        let newKey =
          key[0].toLowerCase() +
          key.slice(1).replace(/_([a-z])/g, function ($0, $1) {
            return $1.toUpperCase();
          });
        result[newKey] = value;
      }
      return result;
    } else {
      // 如果既不是对象也不是数组，返回原值
      return obj;
    }
  }

  // 检查输入类型并调用处理函数
  return toCamelCase(input);
};

// 驼峰转下划线
export const snakeCaseKeys = function (input) {
  // 定义一个处理函数，用于将单个对象中的键转换为下划线命名
  function toSnakeCase(obj) {
    if (Array.isArray(obj)) {
      // 如果是数组，递归映射每个元素到处理函数
      return obj.map(toSnakeCase);
    } else if (typeof obj === 'object' && obj !== null) {
      // 如果是对象，递归处理每个属性
      const result = {};
      for (let key in obj) {
        // 递归处理对象的值
        const value = toSnakeCase(obj[key]);
        let newKey =
          key[0].toLowerCase() +
          key.slice(1).replace(/([A-Z])/g, function ($0, $1) {
            return '_' + $1.toLowerCase();
          });
        result[newKey] = value;
      }
      return result;
    } else {
      // 如果既不是对象也不是数组，返回原值
      return obj;
    }
  }

  // 检查输入类型并调用处理函数
  return toSnakeCase(JSON.parse(JSON.stringify(input)));
};

// 函数用于将 ISO 8601 格式转换为数据库存储的格式
export const convertISOToDatabaseFormat = function (isoDate) {
  // 创建一个 Date 对象
  const date = new Date(isoDate);
  // 将 Date 对象转换为数据库存储的格式
  const databaseFormat = date.toISOString().replace('T', ' ').replace('.000Z', '');
  return databaseFormat;
};

// 前端没有传但后端定义了的参数过滤掉
export const mergeExistingProperties = function (source, outValue = [undefined], outKey = []) {
  let target = {};
  for (const key in source) {
    // 检查value是否在outValue中
    if (outValue.includes(source[key])) {
      continue;
    }
    // 检查key是否在outKey中
    if (outKey.includes(key)) {
      continue;
    }
    // 需要判断空数组
    if (outValue.some((value) => Array.isArray(value) && value.length === 0) && source[key].length === 0) {
      continue;
    }
    // 如果都不在，则添加到target中
    target[key] = source[key];
  }
  return target;
};
// 当前时间拼接
export const requestTime = function (req, res, next) {
  const now = new Date();
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');
  req.requestTime = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  next();
};
// 生成随机数
export const generateUUID = function () {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    let r = (Math.random() * 16) | 0,
      v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

export const getClientIp = function (req) {
  // 处理多层代理场景
  const xff = req.headers['x-forwarded-for'] || '';
  const ips = xff.split(/, ?/g).filter((ip) => ip); // 拆分并过滤空值

  // 排除内网 IP（防止伪造）
  const isPrivate = (ip) => ip.match(/^(10\.|192\.168|172\.(1[6-9]|2\d|3[0-1]))/);

  // 取第一个非内网 IP
  return ips.find((ip) => !isPrivate(ip)) || req.ip;
};

export const baseRouter = [
  {
    path: '/user',
    router: userRouter,
  },
  {
    path: '/json',
    router: jsonRouter,
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
    path: '/chat',
    router: chatRouter,
  },
];
