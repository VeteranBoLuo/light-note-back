/**
 * 会话存储（纯内存）
 *
 * 参考 ai-assistant conversation-store.ts 的设计：
 * - 保留最近 N 轮对话摘要（不存完整消息，存截断后的文本 + 工具摘要）
 * - FIFO：超出上限自动丢弃最早的轮次
 * - 30 分钟无活动自动过期
 * - 会话上下文以 JSON 注入 system prompt，不逐条塞 messages[]
 */

// ---- 配置 ----

/** 最多保留轮数 */
const MAX_TURNS = 10;

/** 单条消息最长字符数（截断） */
const MAX_TEXT_LENGTH = 700;

/** 会话过期时间（毫秒），30 分钟 */
const TTL_MS = 30 * 60 * 1000;

/** 最多保留会话数 */
const MAX_SESSIONS = 100;

// ---- 数据结构 ----

/**
 * @typedef {Object} ToolRecord
 * @property {string} name - 工具名
 * @property {'success'|'error'} status
 * @property {Record<string, unknown>} [params] - 调用参数
 * @property {string} [error] - 错误信息
 */

/**
 * @typedef {Object} ConversationTurn
 * @property {string} user - 用户消息（截断）
 * @property {string} assistant - AI 回复（截断）
 * @property {ToolRecord[]} tools - 本轮使用的工具
 * @property {number} createdAt - 时间戳
 */

/**
 * @typedef {Object} LastToolContext
 * @property {string} name
 * @property {Record<string, unknown>} [params]
 * @property {string} [dataSummary] - 工具返回数据的摘要
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {ConversationTurn[]} turns
 * @property {LastToolContext|null} lastTool
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

// ---- 工具函数 ----

function truncate(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > MAX_TEXT_LENGTH ? s.slice(0, MAX_TEXT_LENGTH) + '...' : s;
}

function now() {
  return Date.now();
}

function isExpired(session) {
  return now() - session.updatedAt > TTL_MS;
}

/** 清理过期会话 */
function cleanupExpired() {
  for (const [id, session] of sessions) {
    if (isExpired(session)) sessions.delete(id);
  }
}

/** 清理最旧会话（超过 MAX_SESSIONS 时） */
function evictOldest() {
  while (sessions.size > MAX_SESSIONS) {
    let oldest = null;
    for (const [id, s] of sessions) {
      if (!oldest || s.updatedAt < oldest.updatedAt) oldest = s;
    }
    if (oldest) sessions.delete(oldest.id);
  }
}

// ---- 公开 API ----

/**
 * 获取或创建会话
 * @param {string} [sessionId]
 * @returns {Session}
 */
export function getOrCreateSession(sessionId) {
  cleanupExpired();

  const id = sessionId?.trim();
  if (id && sessions.has(id)) {
    const session = sessions.get(id);
    if (!isExpired(session)) {
      session.updatedAt = now();
      return session;
    }
    sessions.delete(id);
  }

  const newId = id || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = {
    id: newId,
    turns: [],
    lastTool: null,
    createdAt: now(),
    updatedAt: now(),
  };
  sessions.set(newId, session);
  evictOldest();
  return session;
}

/**
 * 记录一轮成功对话
 * @param {Session} session
 * @param {string} userMsg - 用户原始消息
 * @param {string} assistantMsg - AI 最终回复
 * @param {Array<{ name: string, status: 'success'|'error', params?: Record<string, unknown>, error?: string, dataSummary?: string }>} toolResults
 */
export function recordTurn(session, userMsg, assistantMsg, toolResults = []) {
  session.turns = [
    ...session.turns,
    {
      user: truncate(userMsg),
      assistant: truncate(assistantMsg),
      tools: toolResults.map((r) => ({
        name: r.name,
        status: r.status,
        params: r.params,
        error: r.error,
      })),
      createdAt: now(),
    },
  ].slice(-MAX_TURNS);

  // 更新 lastTool：取最后一个成功的工具
  const lastSuccess = [...toolResults].reverse().find((r) => r.status === 'success');
  if (lastSuccess) {
    session.lastTool = {
      name: lastSuccess.name,
      params: lastSuccess.params,
      dataSummary: lastSuccess.dataSummary,
    };
  }

  session.updatedAt = now();
}

/**
 * 构建会话上下文（JSON 字符串，注入 system prompt）
 * @param {Session} session
 * @returns {string}
 */
export function buildContext(session) {
  if (!session.turns.length && !session.lastTool) return '';

  const ctx = {
    recentTurns: session.turns.map((t) => ({
      user: t.user,
      assistant: t.assistant,
      tools: t.tools,
    })),
    lastSuccessfulTool: session.lastTool || null,
  };

  return [
    '以下是当前会话的历史上下文（最近对话 + 最后一次工具调用），供你理解用户追问和省略表达：',
    JSON.stringify(ctx, null, 2),
    '如果没有可用上下文，不能假装知道上一轮内容，必须按当前问题本身和默认规则处理。',
  ].join('\n');
}

/**
 * 获取会话 ID（供新建会话时返回给前端）
 * @param {Session} session
 * @returns {string}
 */
export function getSessionId(session) {
  return session.id;
}
