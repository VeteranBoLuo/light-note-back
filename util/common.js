const pool = require('../db');
exports.resultData = function (data = null, status = 200, msg = '') {
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
exports.snakeCaseKeys = function (input) {
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
exports.convertISOToDatabaseFormat = function (isoDate) {
  // 创建一个 Date 对象
  const date = new Date(isoDate);
  // 将 Date 对象转换为数据库存储的格式
  const databaseFormat = date.toISOString().replace('T', ' ').replace('.000Z', '');
  return databaseFormat;
};

// 前端没有传但后端定义了的参数过滤掉
exports.mergeExistingProperties = function (source, outValue = [undefined], outKey = []) {
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
exports.requestTime = function (req, res, next) {
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
exports.generateUUID = function () {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    let r = (Math.random() * 16) | 0,
      v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

exports.getClientIp = function (req) {
  // 处理多层代理场景
  const xff = req.headers['x-forwarded-for'] || '';
  const ips = xff.split(/, ?/g).filter((ip) => ip); // 拆分并过滤空值

  // 排除内网 IP（防止伪造）
  const isPrivate = (ip) => ip.match(/^(10\.|192\.168|172\.(1[6-9]|2\d|3[0-1]))/);

  // 取第一个非内网 IP
  return ips.find((ip) => !isPrivate(ip)) || req.ip;
};

exports.baseQuery = async function (req, res, tableName, options = { whereSign: 'AND' }) {
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
      return JSON.parse(JSON.stringify(result));
    } else {
      // 如果既不是对象也不是数组，返回原值
      return JSON.parse(JSON.stringify(obj));
    }
  }

  // 检查输入类型并调用处理函数

  let { pageSize, currentPage, order, filters } = req.body;
  order = toSnakeCase(order);
  filters = toSnakeCase(filters);
  // 检查必传参数
  if (!pageSize || !currentPage) {
    throw new Error('pageSize和currentPage是必传参数');
  }

  // 处理排序
  let orderClause = '';
  if (order && typeof order === 'object' && Object.keys(order).length > 0) {
    const orderBy = [];
    for (const [field, method] of Object.entries(order)) {
      if (!['asc', 'desc'].includes(method.toLowerCase())) {
        throw new Error(`排序方法${method}无效，必须是asc或desc`);
      }
      orderBy.push(`${field} ${method.toUpperCase()}`);
    }
    orderClause = `ORDER BY ${orderBy.join(', ')}`;
  }

  // 处理分页
  let limitClause = '';
  let offset = 0;
  if (pageSize !== -1) {
    const totalPage = parseInt(pageSize);
    const currentPageNum = parseInt(currentPage);
    offset = (currentPageNum - 1) * totalPage;
    limitClause = `LIMIT ${totalPage} OFFSET ${offset}`;
  }

  // 处理过滤条件
  let whereClause = '';
  const whereParams = [];

  // 检查是否需要添加默认的del_flag条件
  if (!filters || !filters.hasOwnProperty('del_flag')) {
    whereClause += 'WHERE del_flag = 0';
  }

  if (filters && Object.keys(filters).length > 0) {
    const conditions = [];
    for (const [key, value] of Object.entries(filters)) {
      if (value === null || value === undefined || value === '') {
        continue;
      }
      // 检查是否有特殊操作符
      const parts = key.split('__');
      if (parts.length === 2) {
        const [field, operator] = parts;
        switch (operator.toLowerCase()) {
          case 'startswith':
            if (value === '') {
              throw new Error('startswith操作符的值不能为空');
            }
            conditions.push(`${field} LIKE ?`);
            whereParams.push(`${value}%`);
            break;
          case 'contains':
            conditions.push(`${field} LIKE ?`);
            whereParams.push(`%${value}%`);
            break;
          case 'endswith':
            if (value === '') {
              throw new Error('endswith操作符的值不能为空');
            }
            conditions.push(`${field} LIKE ?`);
            whereParams.push(`%${value}`);
            break;
          default:
            throw new Error(`无效的操作符${operator}`);
        }
      } else {
        // 普通等值条件
        conditions.push(`${key} = ?`);
        whereParams.push(value);
      }
    }
    if (conditions.length > 0) {
      if (whereClause === '') {
        whereClause += 'WHERE ';
      } else {
        whereClause += ' AND ';
      }
      whereClause += conditions.join(` ${options.whereSign} `);
    }
  }
  // 构建SQL查询
  const querySql = `SELECT * FROM ${tableName} ${whereClause} ${orderClause} ${limitClause}`;
  const [result] = await pool.query(querySql, whereParams);

  // 计算总记录数
  let totalSql = `SELECT COUNT(*) AS total FROM ${tableName} ${whereClause}`;
  const [totalResult] = await pool.query(totalSql, whereParams);
  const total = totalResult[0].total;

  return {
    items: result,
    total: total,
  };
};
