import pool from '../../../db/index.js';
import { resultData, insertData } from '../../../util/common.js';

export default {
  name: 'create_note',
  description: '创建一条新笔记。设定标题和内容后直接保存。',
  plannerHint: '当用户想快速记笔记、保存想法时调用。参数 title 为笔记标题，content 为笔记正文内容。创建成功后返回新笔记的 ID。不处理标签关联，仅创建笔记本身。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '笔记标题，必填' },
      content: { type: 'string', description: '笔记内容正文，支持多行文本' },
    },
    required: ['title'],
  },
  requireRoot: false,
  async execute(args, ctx) {
    const { title, content = '' } = args;
    if (!title?.trim()) {
      return { error: 'TITLE_REQUIRED', message: '笔记标题不能为空' };
    }

    const noteData = insertData({
      title: title.trim(),
      content: content.trim(),
      createBy: ctx.userId,
    });

    await pool.query('INSERT INTO note SET ?', [noteData]);
    return { id: noteData.id, title: title.trim() };
  },
  transform(raw) {
    if (raw.error) return `创建失败：${raw.message}`;
    return `✅ 笔记「${raw.title}」已创建成功（ID: ${raw.id}）`;
  },
  summarize(raw) {
    if (raw.error) return `创建笔记失败：${raw.message}`;
    return `创建笔记「${raw.title}」成功`;
  },
};
