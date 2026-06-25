import pool from '../db/index.js';
dotenv.config({ path: '../.env' });
import dotenv from 'dotenv';
import { requestDeepSeek } from './deepseekClient.js';

async function test() {
  const msg = '给AI规范文档笔记加上重要标签';
  const result = await requestDeepSeek([
    { role: 'system', content: '你是一个助手，回答要简洁。' },
    { role: 'user', content: msg },
  ], {
    tools: [{ type: 'function', function: { name: 'test_tool', description: 'test', parameters: { type: 'object', properties: {} } } }]
  });
  console.log('ToolCalls:', JSON.stringify(result.toolCalls.map(tc => tc.function.name)));
  console.log('Content has XML:', result.content.includes('<invoke'));
  console.log('Content start:', result.content.slice(0, 100));
}

test().catch(console.error);