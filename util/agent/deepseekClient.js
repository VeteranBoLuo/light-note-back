/**
 * DeepSeek API 客户端（OpenAI 兼容接口）
 *
 * 两个核心函数：
 * - requestDeepSeek：同步请求，用于 ReAct 循环中获取 tool_calls
 * - requestDeepSeekStream：流式请求，用于最终回答的逐字输出
 *
 * 参考 ai-assistant 项目 deepseek.ts，适配轻笺 Express 后端。
 */

// ---- 类型（JSDoc，运行时即普通对象）----

/**
 * @typedef {Object} DeepSeekMessage
 * @property {'system'|'user'|'assistant'|'tool'} role
 * @property {string|null} content
 * @property {string} [name]
 * @property {string} [tool_call_id]
 * @property {DeepSeekToolCall[]} [tool_calls]
 */

/**
 * @typedef {Object} DeepSeekToolCall
 * @property {string} id
 * @property {'function'} type
 * @property {{ name: string, arguments: string }} function
 */

/**
 * @typedef {Object} DeepSeekResult
 * @property {string} content - 文本回复
 * @property {DeepSeekToolCall[]} toolCalls - 工具调用列表
 */

const BASE_URL = 'https://api.deepseek.com/v1/chat/completions';

/**
 * 兜底：当 DeepSeek 把函数调用写进 content 文本（XML/DSML 格式）而非 tool_calls 时，
 * 从 text content 中提取工具调用。
 */
function parseXmlToolCalls(content) {
  const calls = [];
  const blockRegex = /<(?:\s*\|\|\s*DSML\s*\|\|\s*)?invoke\s+name="(\w+)"\s*>([\s\S]*?)<\/(?:\s*\|\|\s*DSML\s*\|\|\s*)?invoke\s*>/g;
  let blockMatch;
  while ((blockMatch = blockRegex.exec(content)) !== null) {
    const name = blockMatch[1];
    const inner = blockMatch[2];
    const params = {};
    const paramRegex = /<\s*(?:\|\|\s*DSML\s*\|\|)?\s*parameter\s+name="(\w+)"[^>]*>([^<]+)<\//g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(inner)) !== null) {
      params[paramMatch[1]] = paramMatch[2];
    }
    calls.push({
      id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(params) },
    });
  }
  return calls;
}

function getApiKey() {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('未配置 DEEPSEEK_API_KEY，请检查 .env 文件');
  return key;
}

function getModel() {
  return process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
}

// ---- 同步请求 ----

/**
 * 同步请求 DeepSeek（stream: false）。
 * 用于 Planner 阶段：需要拿到完整的 tool_calls 结果后再执行工具。
 */
export async function requestDeepSeek(messages, options = {}) {
  const body = {
    model: getModel(),
    messages,
    stream: false,
  };

  if (options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice ?? 'auto';
  }

  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
    },
    signal: options.signal,
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message || `DeepSeek 请求失败：${res.status}`);
  }

  const msg = data.choices?.[0]?.message;
  const usage = data.usage || {};
  const result = {
    content: msg?.content || '',
    toolCalls: msg?.tool_calls || [],
    usage: {
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
    },
  };

  // 兜底：检查 content 是否包含 XML/DSML 格式的工具调用
  const parsed = parseXmlToolCalls(result.content);
  if (parsed.length) {
    result.toolCalls = [...result.toolCalls, ...parsed];
    result.content = result.content.replace(/<(?:\s*\|\|\s*DSML\s*\|\|\s*)?invoke[\s\S]*?<\/(?:\s*\|\|\s*DSML\s*\|\|\s*)?invoke\s*>/g, '').trim();
  }

  return result;
}

// ---- 流式请求 ----

/**
 * 流式请求 DeepSeek（stream: true）。
 * 用于 Final Reply 阶段：将 AI 回复逐字推送给前端。
 */
export async function requestDeepSeekStream(messages, options) {
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
    },
    signal: options.signal,
    body: JSON.stringify({
      model: getModel(),
      messages,
      stream: true,
    }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error?.message || `DeepSeek 流式请求失败：${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') continue;

      let chunk;
      try {
        chunk = JSON.parse(dataStr);
      } catch {
        continue;
      }

      if (chunk.error?.message) {
        throw new Error(chunk.error.message);
      }

      const delta = chunk.choices?.[0]?.delta?.content || '';
      if (!delta) continue;
      fullContent += delta;
      options.onDelta(delta);
    }
  }

  return { content: fullContent };
}
