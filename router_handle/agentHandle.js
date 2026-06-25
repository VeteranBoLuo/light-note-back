/**
 * Agent 聊天处理器
 *
 * 核心流程（两段式 Agent）：
 *   用户消息 → sync DeepSeek (带 tools) → 有 tool_calls?
 *     ├─ 是 → 执行工具 → stream DeepSeek (Final Reply) → 逐 chunk 推 SSE
 *     └─ 否 → sync DeepSeek content 直接作为回答 → 单块 SSE
 *
 * 参考 ai-assistant 的 ReAct 模式，适配轻笺 Express 后端。
 */

import pool from '../db/index.js';
import { resultData, generateUUID } from '../util/common.js';
import { retrieve } from '../util/knowledgeService.js';
import { requestDeepSeek, requestDeepSeekStream } from '../util/agent/deepseekClient.js';
import { parseTimeRange } from '../util/agent/timeRange.js';
import { getOrCreateSession, recordTurn, buildContext, getSessionId } from '../util/agent/sessionStore.js';

// ============================================================
// 用户解析（root 查他人数据时用）
// ============================================================

/**
 * 根据昵称/邮箱/ID 查找用户
 * @param {string} keyword
 * @returns {Promise<{ id: string, alias: string } | null>}
 */
async function resolveUser(keyword) {
  const kw = String(keyword).trim();
  if (!kw) return null;
  const [rows] = await pool.query(
    `SELECT id, alias FROM user WHERE (alias = ? OR email = ? OR id = ?) AND del_flag = '0' LIMIT 1`,
    [kw, kw, kw],
  );
  return rows[0] || null;
}


// ============================================================
// Agent 请求日志
// ============================================================

/**
 * 写入 agent_logs 表
 * DeepSeek Flash 定价（人民币）：输入 ¥1/M tokens，输出 ¥2/M tokens
 */
async function logAgentRequest({ userId, userAlias, question, toolsUsed, iterations, totalUsage, durationMs, status, errorMsg }) {
  const cost = (
    (totalUsage.promptTokens / 1_000_000) * 1 +
    (totalUsage.completionTokens / 1_000_000) * 2
  );
  const toolsStr = toolsUsed.map(t => t.name).join(',') || null;
  try {
    const data = {
      id: generateUUID(),
      user_id: userId || '',
      user_alias: userAlias || '',
      question: String(question || '').slice(0, 1000),
      tools_used: toolsStr,
      iterations,
      prompt_tokens: totalUsage.promptTokens,
      completion_tokens: totalUsage.completionTokens,
      total_tokens: totalUsage.totalTokens,
      cost: Number(cost.toFixed(6)),
      status: status || 'success',
      error_msg: errorMsg || null,
      duration_ms: durationMs,
    };
    await pool.query(
      `INSERT INTO agent_logs (id,user_id,user_alias,question,tools_used,iterations,prompt_tokens,completion_tokens,total_tokens,cost,status,error_msg,duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [data.id, data.user_id, data.user_alias, data.question, data.tools_used, data.iterations, data.prompt_tokens, data.completion_tokens, data.total_tokens, data.cost, data.status, data.error_msg, data.duration_ms],
    );
  } catch (err) {
    console.error('[Agent] 写入日志失败:', err.message);
  }
}

// ============================================================
// 工具注册中心（Map-based，扩展只需 registerTool）
// ============================================================

/** @type {Map<string, AgentTool>} */
const toolRegistry = new Map();

/**
 * 注册工具
 * @param {AgentTool} tool
 */
function registerTool(tool) {
  toolRegistry.set(tool.name, tool);
}

/**
 * 获取 OpenAI function-calling 格式的工具定义列表
 * @returns {Array<{ type: 'function', function: { name: string, description: string, parameters: object } }>}
 */
function getToolDefinitions() {
  const defs = [];
  for (const tool of toolRegistry.values()) {
    defs.push({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    });
  }
  return defs;
}

/**
 * 执行工具
 * @param {string} name
 * @param {Record<string, unknown>} args - LLM 传入的参数
 * @param {{ userId: string, userRole: string, userAlias: string }} ctx
 * @returns {Promise<{ status: 'success'|'error', summary: string, error?: string, dataSummary?: string, params?: Record<string, unknown> }>}
 */
async function executeTool(name, args, ctx) {
  const tool = toolRegistry.get(name);
  if (!tool) {
    return { status: 'error', summary: `未知工具: ${name}`, error: 'TOOL_NOT_FOUND' };
  }

  // 权限检查：需要 root 的工具
  if (tool.requireRoot && ctx.userRole !== 'root') {
    return { status: 'error', summary: '权限不足：仅管理员可查询此数据', error: 'FORBIDDEN' };
  }

  // 如果有 user 参数，解析目标用户（仅 root 可用）
  if (args.user && String(args.user).trim()) {
    if (ctx.userRole !== 'root') {
      return { status: 'error', summary: '无权限查看他人数据，仅管理员可指定用户', error: 'FORBIDDEN' };
    }
    const resolved = await resolveUser(args.user);
    if (!resolved) {
      return { status: 'error', summary: `未找到用户"${args.user}"`, error: 'USER_NOT_FOUND' };
    }
    // 替换 ctx 中的 userId 为目标用户
    ctx = { ...ctx, userId: resolved.id, userAlias: resolved.alias };
  }

  try {
    const raw = await tool.execute(args, ctx);
    const summary = tool.transform(raw, args);
    // dataSummary 比 transform 更精简，给 lastTool 用
    const dataSummary = typeof tool.summarize === 'function'
      ? tool.summarize(raw, args)
      : summary.slice(0, 200);
    return {
      status: 'success',
      summary,
      dataSummary,
      params: args,
    };
  } catch (err) {
    console.error(`[Agent] 工具 ${name} 执行失败:`, err.message);
    return {
      status: 'error',
      summary: `查询失败：${err.message}`,
      error: err.message,
      params: args,
    };
  }
}

// ============================================================
// 工具定义与实现
// ============================================================

// ---- 1. search_help_center ----

registerTool({
  name: 'search_help_center',
  description: '搜索帮助中心知识库，获取轻笺的使用说明、功能教程、常见问题解答。当用户问"怎么用"、"什么是"、"如何"等操作性问题时调用。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词，如"标签管理"、"回收站"、"云空间上传"' },
    },
    required: ['query'],
  },
  requireRoot: false,
  async execute(args, ctx) {
    const results = await retrieve(ctx.userId, args.query, 5);
    return results;
  },
  transform(rows) {
    if (!rows?.length) return '帮助中心没有找到相关内容，建议用户查阅完整帮助文档或联系管理员。';
    return rows
      .map((k, i) => `${i + 1}. 【${k.title}】${k.content}`)
      .join('\n\n');
  },
  summarize(rows) {
    if (!rows?.length) return '帮助中心：无结果';
    return `帮助中心：找到 ${rows.length} 篇文章（${rows.map(r => r.title).join('、')}）`;
  },
});

// ---- 2. query_bookmarks ----

registerTool({
  name: 'query_bookmarks',
  description: '查询用户的书签。可按关键词、标签名、时间范围筛选。',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '搜索关键词，匹配书签名称和URL' },
      tag: { type: 'string', description: '标签名称，精确匹配' },
      timeRange: { type: 'string', description: '时间范围，如"最近7天"、"上个月"、"今年"、"全部"' },
      limit: { type: 'integer', description: '返回条数，默认10，最大50' },
      user: { type: 'string', description: '可选，指定查询的用户（昵称/邮箱/ID），仅管理员可用。不填则查自己的数据' },
    },
  },
  requireRoot: false,
async execute(args, ctx) {
  const { keyword, tag, timeRange, limit = 10 } = args;
  const time = parseTimeRange(timeRange);
  const take = Math.min(Math.max(limit || 10, 1), 50);

  // 构建 WHERE 条件（数据查询和 COUNT 共用）
  let where = `b.user_id = ? AND b.del_flag = 0`;
  const baseParams = [ctx.userId];

  if (keyword) {
    where += ` AND (b.name LIKE ? OR b.url LIKE ?)`;
    baseParams.push(`%${keyword}%`, `%${keyword}%`);
  }
  if (tag) {
    where += ` AND b.id IN (
              SELECT rtr.resource_id FROM resource_tag_relations rtr
              JOIN tag t ON t.id = rtr.tag_id
              WHERE t.name = ? AND rtr.resource_type = 'bookmark' AND rtr.user_id = ?)`;
    baseParams.push(tag, ctx.userId);
  }
  if (time) {
    where += ` AND b.create_time >= ? AND b.create_time <= ?`;
    baseParams.push(time.start, time.end);
  }

  // 并行：数据 + 总数
  const [[rows], [countRes]] = await Promise.all([
    pool.query(
      `SELECT b.id, b.name, b.url, b.create_time FROM bookmark b WHERE ${where} ORDER BY b.create_time DESC LIMIT ?`,
      [...baseParams, take],
    ),
    pool.query(
      `SELECT COUNT(*) as total FROM bookmark b WHERE ${where}`,
      baseParams,
    ),
  ]);

  return { total: countRes[0].total, items: rows };
},
transform(raw, args) {
  const items = raw?.items || [];
  if (!items.length) {
    const tagHint = args.tag ? `（标签"${args.tag}"）` : '';
    return `没有找到书签${tagHint}`;
  }
  const lines = items.slice(0, 10).map((r, i) => {
    const name = r.name || '无标题';
    const url = r.url || '';
    const time = r.create_time ? new Date(r.create_time).toLocaleString('zh-CN') : '';
    return `${i + 1}. 《${name}》 ${url} - ${time}`;
  });
  let result = `共 ${raw.total} 条书签：\n${lines.join('\n')}`;
  if (raw.total > 10) result += `\n...（仅展示前 10 条，共 ${raw.total} 条）`;
  return result;
},
summarize(raw, args) {
  if (!raw?.total) return `书签查询：无结果`;
  const keyword = args.keyword ? `关键词"${args.keyword}"` : '';
  return `书签查询${keyword ? `（${keyword}）` : ''}：共 ${raw.total} 条`;
},
});

// ---- 3. query_notes ----

registerTool({
  name: 'query_notes',
  description: '查询用户的笔记。可按关键词（匹配标题和内容）、时间范围筛选。',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '搜索关键词，匹配笔记标题和内容' },
      timeRange: { type: 'string', description: '时间范围，如"最近7天"、"上个月"、"全部"' },
      limit: { type: 'integer', description: '返回条数，默认10，最大50' },
      user: { type: 'string', description: '可选，指定查询的用户（昵称/邮箱/ID），仅管理员可用。不填则查自己的数据' },
    },
  },
  requireRoot: false,
  async execute(args, ctx) {
    const { keyword, timeRange, limit = 10 } = args;
    const time = parseTimeRange(timeRange);
    const take = Math.min(Math.max(limit || 10, 1), 50);

    let where = `n.create_by = ? AND n.del_flag = '0'`;
    const baseParams = [ctx.userId];

    if (keyword) {
      where += ` AND (n.title LIKE ? OR n.content LIKE ?)`;
      baseParams.push(`%${keyword}%`, `%${keyword}%`);
    }
    if (time) {
      where += ` AND n.create_time >= ? AND n.create_time <= ?`;
      baseParams.push(time.start, time.end);
    }

    const [[rows], [countRes]] = await Promise.all([
      pool.query(`SELECT n.id, n.title, n.create_time FROM note n WHERE ${where} ORDER BY n.create_time DESC LIMIT ?`, [...baseParams, take]),
      pool.query(`SELECT COUNT(*) as total FROM note n WHERE ${where}`, baseParams),
    ]);

    return { total: countRes[0].total, items: rows };
  },
  transform(raw, args) {
    const items = raw?.items || [];
    if (!items.length) {
      const kw = args.keyword ? `（关键词"${args.keyword}"）` : '';
      return `没有找到笔记${kw}`;
    }
    const lines = items.map((r, i) => {
      const title = r.title || '无标题';
      const time = r.create_time ? new Date(r.create_time).toLocaleString('zh-CN') : '';
      return `${i + 1}. 《${title}》 - ${time}`;
    });
    return `共 ${raw.total} 条笔记：\n${lines.join('\n')}`;
  },
  summarize(raw, args) {
    if (!raw?.total) return `笔记查询：无结果`;
    const keyword = args.keyword ? `关键词"${args.keyword}"` : '';
    return `笔记查询${keyword ? `（${keyword}）` : ''}：共 ${raw.total} 条`;
  },
});

// ---- 4. query_files ----

registerTool({
  name: 'query_files',
  description: '查询用户云空间的文件。可按关键词（匹配文件名）、文件类型、时间范围筛选。',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '搜索关键词，匹配文件名' },
      type: { type: 'string', description: '文件类型：image(图片)、document(文档)、video(视频)、audio(音频)、other(其他)' },
      timeRange: { type: 'string', description: '时间范围，如"最近7天"、"上个月"、"全部"' },
      limit: { type: 'integer', description: '返回条数，默认10，最大50' },
      user: { type: 'string', description: '可选，指定查询的用户（昵称/邮箱/ID），仅管理员可用。不填则查自己的数据' },
    },
  },
  requireRoot: false,
  async execute(args, ctx) {
    const { keyword, type, timeRange, limit = 10 } = args;
    const time = parseTimeRange(timeRange);
    const take = Math.min(Math.max(limit || 10, 1), 50);

    const typeMap = { image: 'image', document: 'document', video: 'video', audio: 'audio', other: 'other' };

    let where = `f.create_by = ? AND f.del_flag = 0`;
    const baseParams = [ctx.userId];

    if (keyword) {
      where += ` AND f.file_name LIKE ?`;
      baseParams.push(`%${keyword}%`);
    }
    if (type && typeMap[type]) {
      where += ` AND f.file_type LIKE ?`;
      baseParams.push(`${typeMap[type]}%`);
    }
    if (time) {
      where += ` AND f.create_time >= ? AND f.create_time <= ?`;
      baseParams.push(time.start, time.end);
    }

    const [[rows], [countRes]] = await Promise.all([
      pool.query(`SELECT f.id, f.file_name, f.file_type, f.file_size, f.create_time FROM files f WHERE ${where} ORDER BY f.create_time DESC LIMIT ?`, [...baseParams, take]),
      pool.query(`SELECT COUNT(*) as total FROM files f WHERE ${where}`, baseParams),
    ]);

    return { total: countRes[0].total, items: rows };
  },
  transform(raw, args) {
    const items = raw?.items || [];
    if (!items.length) {
      const typeHint = args.type ? `（类型: ${args.type}）` : '';
      return `没有找到文件${typeHint}`;
    }
    const formatSize = (bytes) => {
      if (!bytes || bytes === 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
    };
    const lines = items.map((r, i) => {
      const name = r.file_name || '未知';
      const size = formatSize(r.file_size);
      const time = r.create_time ? new Date(r.create_time).toLocaleString('zh-CN') : '';
      return `${i + 1}. ${name} (${size}) - ${time}`;
    });
    return `共 ${raw.total} 个文件：\n${lines.join('\n')}`;
  },
  summarize(raw, args) {
    if (!raw?.total) return `文件查询：无结果`;
    return `文件查询：共 ${raw.total} 个文件`;
  },
});


// ---- 4b. get_storage_usage ----

registerTool({
  name: 'get_storage_usage',
  description: '查询当前用户的云空间存储用量，包括文件数量和总占用空间。',
  parameters: {
    type: 'object',
    properties: {
      user: { type: 'string', description: '可选，指定查询的用户（昵称/邮箱/ID），仅管理员可用。不填则查自己的数据' },
    },
  },
  requireRoot: false,
  async execute(args, ctx) {
    const [[active], [trash]] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) as fileCount, COALESCE(SUM(file_size), 0) as totalSize FROM files WHERE create_by = ? AND del_flag = 0`,
        [ctx.userId],
      ),
      pool.query(
        `SELECT COUNT(*) as fileCount, COALESCE(SUM(file_size), 0) as totalSize FROM files WHERE create_by = ? AND del_flag = 1`,
        [ctx.userId],
      ),
    ]);
    return {
      fileCount: Number(active[0].fileCount),
      totalSize: Number(active[0].totalSize),
      trashFileCount: Number(trash[0].fileCount || 0),
      trashSize: Number(trash[0].totalSize || 0),
    };
  },
  transform(raw) {
    const formatSize = (bytes) => {
      const b = Number(bytes);
      if (!b || b === 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(b) / Math.log(1024));
      return (b / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
    };
    let result = `云空间：${raw.fileCount} 个文件，已用 ${formatSize(raw.totalSize)}`;
    if (raw.trashFileCount > 0) {
      result += `（回收站还有 ${raw.trashFileCount} 个文件，${formatSize(raw.trashSize)}，合计 ${formatSize(raw.totalSize + raw.trashSize)}）`;
    }
    return result;
  },
  summarize(raw) {
    const formatSize = (bytes) => {
      if (!bytes || bytes === 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
    };
    return `存储用量：${raw.fileCount} 个文件，${formatSize(raw.totalSize)}`;
  },
});
// ---- 5. get_security_events ----

registerTool({
  name: 'get_security_events',
  description: '查询安全攻击事件记录。可按事件类型、IP、处理状态、时间范围筛选。',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', description: '攻击类型：SQL_INJECTION(XSS/SQL注入)、COMMAND_INJECTION(命令注入)、PATH_TRAVERSAL(路径遍历)等' },
      ip: { type: 'string', description: '攻击来源 IP 地址' },
      status: { type: 'string', description: '处理状态：unhandled(未处理)、handled(已处理)、ignored(已忽略)' },
      timeRange: { type: 'string', description: '时间范围，如"今天"、"最近7天"、"本周"，不填则查全部' },
      limit: { type: 'integer', description: '返回条数，默认20，最大100' },
    },
  },
  requireRoot: true,
  async execute(args, ctx) {
    const { type, ip, status, limit = 20 } = args;
    const time = parseTimeRange(args.timeRange);
    const take = Math.min(Math.max(limit || 20, 1), 100);

    let where = '1=1';
    const params = [];

    if (type) {
      where += ` AND se.attack_type LIKE ?`;
      params.push(`%${type}%`);
    }
    if (ip) {
      where += ` AND se.source_ip = ?`;
      params.push(ip);
    }
    if (status) {
      where += ` AND se.handled_status = ?`;
      params.push(status);
    }
    if (time) {
      where += ` AND se.created_at >= ? AND se.created_at <= ?`;
      params.push(time.start, time.end);
    }

    const sql = `SELECT se.attack_type, se.source_ip, se.request_path, se.handled_status, se.threat_score, se.created_at FROM security_events se WHERE ${where} ORDER BY se.created_at DESC LIMIT ?`;
    params.push(take);

    const [rows] = await pool.query(sql, params);
    return rows;
  },
  transform(rows) {
    if (!rows?.length) return '没有找到安全事件记录';
    const lines = rows.map((r, i) => {
      const time = r.created_at ? new Date(r.created_at).toLocaleString('zh-CN') : '';
      return `${i + 1}. [${r.attack_type}] ${r.source_ip} → ${r.request_path} (风险分: ${r.threat_score}, 状态: ${r.handled_status}) - ${time}`;
    });
    return `共 ${rows.length} 条安全事件：\n${lines.join('\n')}`;
  },
  summarize(rows) {
    if (!rows?.length) return '安全事件：无记录';
    const types = [...new Set(rows.map(r => r.attack_type))];
    return `安全事件：共 ${rows.length} 条，类型：${types.join('、')}`;
  },
});

// ---- 6. get_security_summary ----

registerTool({
  name: 'get_security_summary',
  description: '获取安全概览，包括 IP 风险排行和账号风险排行。',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: '返回条数，默认10，最大50' },
    },
  },
  requireRoot: true,
  async execute(args) {
    const take = Math.min(Math.max(args.limit || 10, 1), 50);

    // 并行查询 IP 和账号风险
    const [ipRows] = await pool.query(
      `SELECT ip, risk_score, is_banned, total_attacks
       FROM security_ip_reputation
       ORDER BY risk_score DESC LIMIT ?`,
      [take],
    );
    const [accountRows] = await pool.query(
      `SELECT sar.user_id, u.alias, sar.risk_score, sar.total_events
       FROM security_account_reputation sar
       LEFT JOIN user u ON u.id = sar.user_id
       ORDER BY sar.risk_score DESC LIMIT ?`,
      [take],
    );

    return { ipRisks: ipRows, accountRisks: accountRows };
  },
  transform(raw) {
    const parts = [];

    if (raw.ipRisks?.length) {
      const ips = raw.ipRisks.map((r, i) =>
        `${i + 1}. ${r.ip} - 风险分: ${r.risk_score}，攻击 ${r.total_attacks} 次${r.is_banned ? '，已封禁' : ''}`);
      parts.push(`⚠️ IP 风险 Top ${raw.ipRisks.length}：\n${ips.join('\n')}`);
    }

    if (raw.accountRisks?.length) {
      const acts = raw.accountRisks.map((r, i) =>
        `${i + 1}. ${r.alias || r.user_id} - 风险分: ${r.risk_score}，事件 ${r.total_events} 次`);
      parts.push(`👤 账号风险 Top ${raw.accountRisks.length}：\n${acts.join('\n')}`);
    }

    return parts.length ? parts.join('\n\n') : '暂无风险数据';
  },
  summarize(raw) {
    const ipCount = raw.ipRisks?.length || 0;
    const acctCount = raw.accountRisks?.length || 0;
    return `安全概览：${ipCount} 个风险 IP，${acctCount} 个风险账号`;
  },
});

// ---- 7. query_users ----

registerTool({
  name: 'query_users',
  description: '查询平台用户列表。可按关键词（昵称/邮箱）筛选。',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '搜索关键词，匹配昵称和邮箱' },
      limit: { type: 'integer', description: '返回条数，默认10，最大50' },
    },
  },
  requireRoot: true,
  async execute(args) {
    const { keyword, limit = 10 } = args;
    const take = Math.min(Math.max(limit || 10, 1), 50);

    let sql = `SELECT u.id, u.alias, u.email, u.role, u.create_time
               FROM user u WHERE 1=1`;
    const params = [];

    if (keyword) {
      sql += ` AND (u.alias LIKE ? OR u.email LIKE ? OR u.id LIKE ?)`;
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    sql += ` ORDER BY u.create_time DESC LIMIT ?`;
    params.push(take);

    const [rows] = await pool.query(sql, params);
    return rows;
  },
  transform(rows) {
    if (!rows?.length) return '没有找到用户';
    const lines = rows.map((r, i) => {
      const time = r.create_time ? new Date(r.create_time).toLocaleString('zh-CN') : '';
      return `${i + 1}. ${r.alias || '未知'} (${r.email}) - ${r.role} - ${time}`;
    });
    return `共 ${rows.length} 个用户：\n${lines.join('\n')}`;
  },
  summarize(rows) {
    if (!rows?.length) return '用户查询：无结果';
    return `用户查询：共 ${rows.length} 个用户`;
  },
});

// ---- 8. query_api_logs ----

registerTool({
  name: 'query_api_logs',
  description: '查询 API 请求日志。可按关键词、用户、时间范围筛选。',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '搜索关键词，匹配请求URL路径' },
      user: { type: 'string', description: '可选，指定查询的用户（昵称/邮箱/ID），不填则查所有用户' },
      timeRange: { type: 'string', description: '时间范围，如"今天"、"最近7天"，不填则查全部' },
      limit: { type: 'integer', description: '返回条数，默认20，最大100' },
    },
  },
  requireRoot: true,
  async execute(args, ctx) {
    const { keyword, limit = 20 } = args;
    const time = parseTimeRange(args.timeRange);
    const take = Math.min(Math.max(limit || 20, 1), 100);

    let where = '1=1';
    const params = [];

    if (keyword) {
      where += ` AND a.url LIKE ?`;
      params.push(`%${keyword}%`);
    }
    if (time) {
      where += ` AND a.request_time >= ? AND a.request_time <= ?`;
      params.push(time.start, time.end);
    }

    const sql = `SELECT a.url, a.status_code, a.user_id, a.request_time FROM api_logs a WHERE ${where} ORDER BY a.request_time DESC LIMIT ?`;
    params.push(take);

    const [rows] = await pool.query(sql, params);
    return rows;
  },
  transform(rows) {
    if (!rows?.length) return '没有找到 API 日志';
    const lines = rows.map((r, i) => {
      const time = r.request_time ? new Date(r.request_time).toLocaleString('zh-CN') : '';
      return `${i + 1}. ${r.url} → ${r.status_code} - ${time}`;
    });
    return `共 ${rows.length} 条 API 请求：\n${lines.join('\n')}`;
  },
  summarize(rows) {
    if (!rows?.length) return 'API 日志：无记录';
    // 统计状态码分布
    const codes = {};
    rows.forEach(r => { codes[r.status_code] = (codes[r.status_code] || 0) + 1; });
    const stats = Object.entries(codes).map(([k, v]) => `${k}:${v}`).join(', ');
    return `API 日志：共 ${rows.length} 条 (${stats})`;
  },
});

// ---- 9. query_operation_logs ----

registerTool({
  name: 'query_operation_logs',
  description: '查询用户操作日志。可按关键词、模块、用户、时间范围筛选。',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '搜索关键词，匹配操作内容' },
      module: { type: 'string', description: '操作模块：bookmark(书签)、note(笔记)、file(文件)、security(安全)等' },
      user: { type: 'string', description: '可选，指定查询的用户（昵称/邮箱/ID），不填则查所有用户' },
      timeRange: { type: 'string', description: '时间范围，如"今天"、"最近7天"，不填则查全部' },
      module: { type: 'string', description: '操作模块：bookmark(书签)、note(笔记)、file(文件)、security(安全)等' },
      limit: { type: 'integer', description: '返回条数，默认20，最大100' },
    },
  },
  requireRoot: true,
  async execute(args, ctx) {
    const { keyword, module, limit = 20 } = args;
    const time = parseTimeRange(args.timeRange);
    const take = Math.min(Math.max(limit || 20, 1), 100);

    let where = '1=1';
    const params = [];

    if (keyword) {
      where += ` AND ol.operation LIKE ?`;
      params.push(`%${keyword}%`);
    }
    if (module) {
      where += ` AND ol.module = ?`;
      params.push(module);
    }
    if (time) {
      where += ` AND ol.create_time >= ? AND ol.create_time <= ?`;
      params.push(time.start, time.end);
    }

    const sql = `SELECT ol.module, ol.operation, ol.create_by, ol.create_time FROM operation_logs ol WHERE ${where} ORDER BY ol.create_time DESC LIMIT ?`;
    params.push(take);

    const [rows] = await pool.query(sql, params);
    return rows;
  },
  transform(rows) {
    if (!rows?.length) return '没有找到操作日志';
    const lines = rows.map((r, i) => {
      const time = r.create_time ? new Date(r.create_time).toLocaleString('zh-CN') : '';
      return `${i + 1}. [${r.module}] ${r.operation} - ${time}`;
    });
    return `共 ${rows.length} 条操作记录：\n${lines.join('\n')}`;
  },
  summarize(rows) {
    if (!rows?.length) return '操作日志：无记录';
    const modules = [...new Set(rows.map(r => r.module))];
    return `操作日志：共 ${rows.length} 条，模块：${modules.join('、')}`;
  },
});

// ============================================================
// System Prompt
// ============================================================


// ---- 10. get_active_users ----

registerTool({
  name: 'get_active_users',
  description: '查询最近活跃的用户排行。按 API 请求次数降序排列。用来回答"最近哪些用户活跃"、"谁用得最多"等问题。',
  parameters: {
    type: 'object',
    properties: {
      timeRange: { type: 'string', description: '时间范围，如"今天"、"最近7天"、"本周"、"最近30天"，默认最近7天' },
      limit: { type: 'integer', description: '返回用户数，默认10，最大50' },
    },
  },
  requireRoot: true,
  async execute(args, ctx) {
    const { limit = 10 } = args;
    const take = Math.min(Math.max(limit || 10, 1), 50);
    const time = parseTimeRange(args.timeRange || '最近7天');

    let where = '1=1';
    const params = [];

    if (time) {
      where += ' AND a.request_time >= ? AND a.request_time <= ?';
      params.push(time.start, time.end);
    }

    const [rows] = await pool.query(
      `SELECT u.alias, u.email, COUNT(*) as request_count, MAX(a.request_time) as last_active
       FROM api_logs a JOIN user u ON a.user_id = u.id
       WHERE ${where} AND a.user_id IS NOT NULL AND a.user_id != ''
       GROUP BY a.user_id, u.alias, u.email
       ORDER BY request_count DESC LIMIT ?`,
      [...params, take],
    );
    return rows;
  },
  transform(rows) {
    if (!rows?.length) return '该时间段内没有用户活动记录';
    const lines = rows.map((r, i) => {
      const alias = r.alias || '未知';
      const lastTime = r.last_active ? new Date(r.last_active).toLocaleString('zh-CN') : '';
      return `${i + 1}. ${alias} (${r.email || '无邮箱'}) — ${r.request_count} 次请求，最后活跃: ${lastTime}`;
    });
    return `活跃用户排行：\n${lines.join('\n')}`;
  },
  summarize(rows) {
    if (!rows?.length) return '活跃用户：无';
    return `活跃用户：${rows.length} 人，最高 ${rows[0]?.request_count || 0} 次请求`;
  },
});


// ---- 11. get_token_usage ----

registerTool({
  name: 'get_token_usage',
  description: '查询 Token 消耗统计。可按时间范围汇总，也可指定用户。用来回答"今天消耗了多少token"、"本周费用多少"等问题。',
  parameters: {
    type: 'object',
    properties: {
      timeRange: { type: 'string', description: '时间范围，如"今天"、"最近7天"、"本周"、"本月"，默认今天' },
      user: { type: 'string', description: '可选，指定查询的用户（昵称/邮箱/ID），不填则查全部用户' },
    },
  },
  requireRoot: true,
  async execute(args, ctx) {
    const time = parseTimeRange(args.timeRange || '今天');

    let where = '1=1';
    const params = [];

    if (time) {
      where += ' AND created_at >= ? AND created_at <= ?';
      params.push(time.start, time.end);
    }

    const [rows] = await pool.query(
      `SELECT COUNT(*) as request_count, COALESCE(SUM(prompt_tokens),0) as total_prompt, COALESCE(SUM(completion_tokens),0) as total_completion, COALESCE(SUM(total_tokens),0) as total_tokens, COALESCE(SUM(cost),0) as total_cost
       FROM agent_logs WHERE ${where}`,
      params,
    );
    return rows[0];
  },
  transform(raw) {
    const count = Number(raw.request_count || 0);
    if (!count) return '该时间段内没有 AI 调用记录';
    return `Token 消耗统计：
• 请求次数：${count} 次
• Prompt Token：${Number(raw.total_prompt).toLocaleString()} tk
• 输出 Token：${Number(raw.total_completion).toLocaleString()} tk
• 总 Token：${Number(raw.total_tokens).toLocaleString()} tk
• 费用合计：¥${Number(raw.total_cost).toFixed(4)}`;
  },
  summarize(raw) {
    const count = Number(raw.request_count || 0);
    if (!count) return 'Token消耗：无记录';
    return `Token消耗：${count} 次请求，¥${Number(raw.total_cost).toFixed(4)}`;
  },
});

const SYSTEM_PROMPT = `你是轻笺（Light Note）的 AI 助手。轻笺是一个个人知识管理工具，支持书签管理、笔记、云空间等功能。

## 你的能力
你可以通过工具查询用户的真实数据来回答问题。工具包括：
- search_help_center：搜索帮助中心（使用教程、功能说明）
- query_bookmarks：查询书签
- query_notes：查询笔记
- query_files：查询云空间文件
- get_storage_usage：查询云空间存储用量（文件数 + 占用空间）

管理员（root）可以通过 user 参数查询其他用户的数据，例如 query_bookmarks({ user: "昵称或邮箱" })
- get_security_events / get_security_summary：安全事件（仅管理员）
- query_users：用户列表（仅管理员）
- query_api_logs / query_operation_logs：日志查询（仅管理员）

## 行为规则
1. 用户问自己的数据（书签/笔记/文件）时，必须调用工具查询，不能编造或猜测数据
2. 用户问操作性问题（怎么用、在哪里、如何），即使是简单操作也必须先调用 search_help_center 查询帮助文档再回答，不能凭自己知识直接回答
3. 安全/管理类工具仅管理员可用。如果你不是管理员但用户要求查这些数据，告知"该功能仅管理员可用"
4. 跨模块问题可以同时调用多个工具（如"查关于MySQL的书签和笔记"）
5. 工具返回空结果时，如实告知用户"没有找到相关数据"
6. 闲聊、打招呼不需要调工具，直接回复
7. 回答简洁、用中文、不虚构数据和功能

## 时间范围
涉及时间查询时，使用以下表达式之一：最近N天、昨天、前天、本周、上周、本月、上个月、今年、全部。`;

// ============================================================
// 主 Handler
// ============================================================

/**
 * POST /api/chat/agent
 */
export async function agentChat(req, res) {
  req.setTimeout(0);

  let stream = false;

  try {
    const {
      message,
      sessionId = '',
      enableTranslation = false,
      translationConfig = {},
    } = req.body;
    stream = req.body.stream ?? false;

    if (!message?.trim()) {
      return res.status(400).send(resultData(null, 400, '消息不能为空'));
    }

    // 用户身份
    const userId = req.user?.id || 'visitor';
    const userRole = req.user?.role || 'visitor';
    const userAlias = req.user?.alias || '访客';

    // 会话
    const session = getOrCreateSession(sessionId);
    const contextStr = buildContext(session);

    // 构建 system prompt
    const systemContent = contextStr
      ? `${SYSTEM_PROMPT}\n\n---\n\n${contextStr}`
      : SYSTEM_PROMPT;

    // 处理翻译模式
    let userMessage = message;
    if (enableTranslation) {
      const { source = 'auto', target = 'zh' } = translationConfig || {};
      const langNames = { auto: '自动识别', zh: '中文', en: '英文', ja: '日文', ko: '韩文' };
      const targetName = langNames[target] || target;
      const sourceHint = source === 'auto' ? '' : `（源语言: ${langNames[source] || source}）`;
      userMessage = `请将以下内容翻译成${targetName}${sourceHint}：\n\n${message}`;
    }

    // 构建 messages 数组
    /** @type {import('../util/agent/deepseekClient.js').DeepSeekMessage[]} */
    const messages = [
      { role: 'system', content: systemContent },
      { role: 'user', content: userMessage },
    ];

    // 流式模式：提前设置 SSE headers + 客户端断开时 abort DeepSeek 流
    const agentAbortController = new AbortController();
    const onClientClose = () => {
      if (!agentAbortController.signal.aborted) {
        agentAbortController.abort();
      }
    };
    req.on('close', onClientClose);

    if (stream) {
      // 禁用 Nagle 算法，确保每个 SSE chunk 立即推送不被 TCP 合并缓冲
      if (res.socket) res.socket.setNoDelay(true);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    }

    // 工具定义
    const toolDefs = getToolDefinitions();

    /** @type {Array<{ name: string, status: string, params?: object, error?: string, dataSummary?: string }>} */
    const usedTools = [];
    let finalContent = '';
    const startTime = Date.now();
    let apiCalls = 0;
    // 累计所有 DeepSeek 调用的 token 用量
    const totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    // ---- 第1步：Planner（带工具定义，让 LLM 决定是否调工具） ----
    const plannerResponse = await requestDeepSeek(messages, { tools: toolDefs });
    apiCalls++;
    totalUsage.promptTokens += plannerResponse.usage.promptTokens;
    totalUsage.completionTokens += plannerResponse.usage.completionTokens;
    totalUsage.totalTokens += plannerResponse.usage.totalTokens;

    if (!plannerResponse.toolCalls?.length) {
      // 无工具调用 → 直接当作回答，跳过 Final Reply
      finalContent = plannerResponse.content || '';
    } else {
      // 追加 assistant 消息（含 tool_calls）
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: plannerResponse.toolCalls,
      });

      // 并行执行所有工具
      const results = await Promise.all(
        plannerResponse.toolCalls.map(async (tc) => {
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            args = {};
          }
          const result = await executeTool(tc.function.name, args, { userId, userRole, userAlias });
          usedTools.push({
            name: tc.function.name,
            status: result.status,
            params: args,
            error: result.error,
            dataSummary: result.dataSummary,
          });
          return { toolCallId: tc.id, result };
        }),
      );

      // 追加 tool 结果消息
      for (const r of results) {
        messages.push({
          role: 'tool',
          tool_call_id: r.toolCallId,
          content: r.result.summary,
        });
      }

      // ---- 第2步：Final Reply ----
      messages.push({
        role: 'user',
        content: '请基于上述工具结果给出简洁的总结。',
      });

      if (stream) {
        // 流式：边生成边推 SSE，前端打字机逐字渲染
        await requestDeepSeekStream(messages, {
          onDelta: (chunk) => {
            finalContent += chunk;
            res.write(`data: ${JSON.stringify({ output: { text: chunk, session_id: getSessionId(session) } })}\n\n`);
          },
          signal: agentAbortController.signal,
        });
        apiCalls++;
        // 流式无法获取 token 用量，不累计 totalUsage
        if (!finalContent) finalContent = '抱歉，无法处理该请求。';
      } else {
        const finalResponse = await requestDeepSeek(messages, { toolChoice: 'none' });
        apiCalls++;
        totalUsage.promptTokens += finalResponse.usage.promptTokens;
        totalUsage.completionTokens += finalResponse.usage.completionTokens;
        totalUsage.totalTokens += finalResponse.usage.totalTokens;
        finalContent = finalResponse.content || '抱歉，无法处理该请求。';
      }
    }

    // ---- 输出 ----
    if (stream) {
      // SSE 输出：headers 已在前面提前设置
      // 无工具调用路径（Planner 直接回复）：发送单块 SSE
      // 有工具调用路径：Final Reply 已逐 chunk 推完 SSE，只需 [DONE]
      if (!usedTools.length) {
        res.write(`data: ${JSON.stringify({ output: { text: finalContent, session_id: getSessionId(session) } })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      res.removeListener('close', onClientClose);
    } else {
      // 非流式
      res.send(resultData({ response: finalContent, sessionId: getSessionId(session) }));
      res.removeListener('close', onClientClose);
    }

    // 记录本轮对话
    recordTurn(session, message, finalContent, usedTools);

    // 异步写日志（不阻塞响应）

    logAgentRequest({
      userId, userAlias,
      question: message,
      toolsUsed: usedTools,
      iterations: apiCalls,
      totalUsage,
      durationMs: Date.now() - startTime,
      status: 'success',
    });
  } catch (error) {
    console.error('[Agent] 请求错误:', error.message);
    if (stream) {
      try {
        res.write(`data: ${JSON.stringify({ error: '服务异常', message: error.message })}\n\n`);
        res.end();
      } catch (_) { /* ignore */ }
    } else {
      res.status(500).send(resultData(null, 500, 'AI 服务异常: ' + error.message));
    }
    res.removeListener('close', onClientClose);
  }
}
