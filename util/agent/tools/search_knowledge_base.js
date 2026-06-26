import { retrieve } from '../../knowledgeService.js';

export default {
  name: 'search_knowledge_base',
  description: '搜索知识库，获取轻笺的使用说明、功能教程、常见问题解答、内部知识。当用户问"怎么用"、"什么是"、"如何"等操作性问题时调用。',
  plannerHint: '当用户问操作性问题（怎么用、在哪里设置、是什么功能、如何操作）时，必须优先调用此工具查询知识库。不能在未查询的情况下凭知识回答。关键词示例：标签管理、回收站、云空间上传、导出书签。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词，如"标签管理"、"回收站"、"云空间上传"' },
    },
    required: ['query'],
  },
  requireRoot: false,
  async execute(args, ctx) {
    const onlyPublic = ctx.userRole !== 'root';
    const results = await retrieve(ctx.userId, args.query, 5, onlyPublic);
    return results;
  },
  transform(rows) {
    if (!rows?.length) return '知识库没有找到相关内容，建议查阅完整帮助文档或联系管理员。';
    return rows
      .map((k, i) => `${i + 1}. 【${k.title}】${k.content}`)
      .join('\n\n');
  },
  summarize(rows) {
    if (!rows?.length) return '知识库：无结果';
    return `知识库：找到 ${rows.length} 条结果（${rows.map(r => r.title).join('、')}）`;
  },
};
