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
import { requestDeepSeek, requestDeepSeekStream } from '../util/agent/deepseekClient.js';
import { parseTimeRange } from '../util/agent/timeRange.js';
import { getOrCreateSession, recordTurn, buildContext, getSessionId, getPendingAction, setPendingAction, clearPendingAction } from '../util/agent/sessionStore.js';
import { buildPlannerPrompt } from '../util/agent/prompt.js';
import toolDefsArray from '../util/agent/tools/index.js';

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

// 注册所有工具
toolDefsArray.forEach(t => registerTool(t));

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
      pendingConfirm: raw?.pendingConfirm || false,
      confirmData: raw?.pendingConfirm ? { resourceType: raw.resourceType, resourceName: raw.resourceName, confirmMessage: raw.confirmMessage } : null,
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
    const session = await getOrCreateSession(sessionId);
    const contextStr = buildContext(session);

    // 构建 system prompt（动态：根据角色决定工具提示详略）
    const prompt = buildPlannerPrompt(toolRegistry, userRole);
    const systemContent = contextStr
      ? `${prompt}\n\n---\n\n${contextStr}`
      : prompt;

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
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    }

    // 工具定义
    const toolDefs = getToolDefinitions();

    // 删除操作：后端直接检测并执行，绕过 DeepSeek 的搜索帮助中心偏好
    const deletePattern = /^(删|删除|删掉|把.*删)/;
    if (deletePattern.test(message.trim()) && !getPendingAction(session)) {
      const result = await executeTool('delete_resource', { resourceType: 'tag', resourceName: message.replace(/^(删|删除|删掉|把)/, '').replace(/了$/, '').replace(/(标签|笔记|书签|文件)$/, '').trim() || '测试', confirmed: false }, { userId, userRole, userAlias });
      if (result.pendingConfirm) {
        setPendingAction(session, { toolName: 'delete_resource', params: { resourceType: 'tag', resourceName: result.confirmData?.resourceName || '' }, confirmData: result.confirmData });
        finalContent = result.summary;
        if (stream) {
          if (result.confirmData) {
            res.write(`data: ${JSON.stringify({ output: { text: result.summary, session_id: getSessionId(session) }, confirmAction: result.confirmData })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({ output: { text: result.summary, session_id: getSessionId(session) } })}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
          res.removeListener('close', onClientClose);
        } else {
          res.send(resultData({ response: result.summary, sessionId: getSessionId(session) }));
          res.removeListener('close', onClientClose);
        }
        recordTurn(session, message, finalContent, [{ name: 'delete_resource', status: 'success', params: { resourceType: 'tag', resourceName: 'test' } }]);
        return;
      }
    }

    // 检查待确认操作
    const pendingAction = getPendingAction(session);
    if (pendingAction && /^(确认|确认删除|是|可以|yes|confirm|ok)$/i.test(message.trim())) {
      // 用户确认了待删除操作，直接执行工具
      const tool = toolRegistry.get(pendingAction.toolName);
      if (tool) {
        const args = { ...pendingAction.params, confirmed: true };
        const result = await executeTool(pendingAction.toolName, args, { userId, userRole, userAlias });
        finalContent = result.summary;
        clearPendingAction(session);
        if (usedTools.length === 0) {
          // 只有确认时的工具调用
          usedTools.push({ name: pendingAction.toolName, status: result.status, params: args });
        }
        // 直接跳到输出
        if (stream) {
          res.write(`data: ${JSON.stringify({ output: { text: finalContent, session_id: getSessionId(session) } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          res.removeListener('close', onClientClose);
        } else {
          res.send(resultData({ response: finalContent, sessionId: getSessionId(session) }));
          res.removeListener('close', onClientClose);
        }
        recordTurn(session, message, finalContent, usedTools);
        return;
      }
    }
    if (pendingAction && /^(取消|不|no|cancel)$/i.test(message.trim())) {
      clearPendingAction(session);
      finalContent = '已取消操作。';
      if (stream) {
        res.write(`data: ${JSON.stringify({ output: { text: finalContent, session_id: getSessionId(session) } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        res.removeListener('close', onClientClose);
      } else {
        res.send(resultData({ response: finalContent, sessionId: getSessionId(session) }));
        res.removeListener('close', onClientClose);
      }
      recordTurn(session, message, finalContent, usedTools);
      return;
    }

    // ---- 第1步：Planner
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
          return { toolCallId: tc.id, toolName: tc.function.name, result };
        }),
      );

      // 检查是否有工具需要用户确认
      const needConfirm = results.find(r => r.result.pendingConfirm);
      if (needConfirm) {
        setPendingAction(session, {
          toolName: needConfirm.toolName,
          params: needConfirm.result.params,
          confirmData: needConfirm.result.confirmData,
        });
      }

      // 追加 tool 结果消息
      for (const r of results) {
        messages.push({
          role: 'tool',
          tool_call_id: r.toolCallId,
          content: r.result.summary,
        });
      }

      // ---- 第2步：Final Reply ----
      // 如需用户确认，先推 confirmAction 事件
      const pendingActionForSSE = getPendingAction(session);
      const confirmActionChunk = pendingActionForSSE?.confirmData
        ? JSON.stringify({ output: { text: '', session_id: getSessionId(session) }, confirmAction: pendingActionForSSE.confirmData })
        : null;

      messages.push({
        role: 'user',
        content: '请基于上述工具结果给出简洁的总结。',
      });

      if (stream) {
        // 推确认事件
        if (confirmActionChunk) {
          res.write(`data: ${confirmActionChunk}\n\n`);
        }
        // 流式：首批 buffer 掩盖 DeepSeek token 间隔 gap
        let bufferStart = 0;
        let bufferText = '';
        let isBuffering = true;
        const BUFFER_MS = 150;
        const BUFFER_CHARS = 12;

        await requestDeepSeekStream(messages, {
          onDelta: (chunk) => {
            if (isBuffering && bufferStart === 0) {
              bufferStart = Date.now();
              bufferText = chunk;
              return;
            }

            if (isBuffering) {
              bufferText += chunk;
              const elapsed = Date.now() - bufferStart;
              if (elapsed >= BUFFER_MS || bufferText.length >= BUFFER_CHARS) {
                finalContent += bufferText;
                res.write(`data: ${JSON.stringify({ output: { text: bufferText, session_id: getSessionId(session) } })}\n\n`);
                isBuffering = false;
              }
              return;
            }

            finalContent += chunk;
            res.write(`data: ${JSON.stringify({ output: { text: chunk, session_id: getSessionId(session) } })}\n\n`);
          },
          signal: agentAbortController.signal,
        });

        if (isBuffering && bufferText) {
          finalContent += bufferText;
          res.write(`data: ${JSON.stringify({ output: { text: bufferText, session_id: getSessionId(session) } })}\n\n`);
        }

        apiCalls++;
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
      if (!usedTools.length) {
        res.write(`data: ${JSON.stringify({ output: { text: finalContent, session_id: getSessionId(session) } })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      res.removeListener('close', onClientClose);
    } else {
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
