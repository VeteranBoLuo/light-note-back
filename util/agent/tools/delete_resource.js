import pool from '../../../db/index.js';

const VALID_TYPES = ['bookmark', 'note', 'file', 'tag'];
const TYPE_INFO = {
  bookmark: { table: 'bookmark', userIdField: 'user_id', nameField: 'name' },
  note: { table: 'note', userIdField: 'create_by', nameField: 'title' },
  file: { table: 'files', userIdField: 'create_by', nameField: 'file_name' },
  tag: { table: 'tag', userIdField: 'user_id', nameField: 'name' },
};

async function pendingConfirm(type, name, userId) {
  let extra = '';
  if (type === 'tag') {
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM resource_tag_relations WHERE tag_id IN (SELECT id FROM tag WHERE user_id = ? AND name = ? AND del_flag = 0)',
      [userId, name],
    );
    const count = Number(rows[0]?.cnt || 0);
    extra = count > 0 ? `（关联 ${count} 个资源）` : '';
  }
  return {
    pendingConfirm: true,
    resourceType: type,
    resourceName: name,
    confirmMessage: `${type === 'tag' ? '标签' : type === 'bookmark' ? '书签' : type === 'note' ? '笔记' : '文件'}「${name}」${extra}`,
  };
}

export default {
  name: 'delete_resource',
  description: '当用户说"删掉""删除""把...删了"时调用此工具。支持删除书签、笔记、文件和标签。第一次调用先不确认（confirmed=false），返回待删内容的确认信息。用户确认后第二次调用带 confirmed=true 真正执行删除。',
  plannerHint: '当用户要求删除书签、笔记、文件或标签时直接调用，不要先查帮助中心。confirmed=true 时才真正执行删除，confirmed=false 时只返回确认提示。',
  parameters: {
    type: 'object',
    properties: {
      resourceType: { type: 'string', description: '资源类型：bookmark(书签)、note(笔记)、file(文件)、tag(标签)' },
      resourceName: { type: 'string', description: '资源名称，模糊搜索匹配' },
      confirmed: { type: 'boolean', description: '是否确认执行删除。false=仅查询，true=确认后真正删除' },
    },
    required: ['resourceType', 'resourceName'],
  },
  requireRoot: false,
  async execute(args, ctx) {
    const resourceType = args.resourceType || args.type || '';
    const resourceName = args.resourceName || args.name || args.resourceId || '';
    const confirmed = args.confirmed === true;

    if (!VALID_TYPES.includes(resourceType)) {
      return { error: 'INVALID_TYPE', message: `不支持的资源类型：${resourceType}` };
    }
    if (!resourceName?.trim()) {
      return { error: 'NAME_REQUIRED', message: '资源名称不能为空' };
    }

    const info = TYPE_INFO[resourceType];

    const [resources] = await pool.query(
      `SELECT id, ${info.nameField} AS name FROM \`${info.table}\`
       WHERE ${info.userIdField} = ? AND del_flag = 0 AND ${info.nameField} LIKE ?
       ORDER BY create_time DESC LIMIT 1`,
      [ctx.userId, `%${resourceName.trim()}%`],
    );
    if (resources.length === 0) {
      return { error: 'NOT_FOUND', message: `未找到名称包含"${resourceName.trim()}"的${resourceType}` };
    }

    const matchedId = resources[0].id;
    const matchedName = resources[0].name;

    if (!confirmed) {
      return await pendingConfirm(resourceType, matchedName, ctx.userId);
    }

    // 确认后执行
    if (resourceType === 'tag') {
      await pool.query('DELETE FROM resource_tag_relations WHERE tag_id = ? AND user_id = ?', [matchedId, ctx.userId]);
      await pool.query('DELETE FROM tag_relations WHERE tag_id = ? OR related_tag_id = ?', [matchedId, matchedId]);
      await pool.query('DELETE FROM tag WHERE id = ? AND user_id = ?', [matchedId, ctx.userId]);
    } else {
      await pool.query('DELETE FROM resource_tag_relations WHERE resource_type = ? AND resource_id = ? AND user_id = ?', [
        resourceType, matchedId, ctx.userId,
      ]);
      await pool.query(
        `UPDATE \`${info.table}\` SET del_flag = 1, deleted_at = NOW() WHERE id = ? AND ${info.userIdField} = ?`,
        [matchedId, ctx.userId],
      );
    }

    return { resourceType, resourceName: matchedName, deleted: true };
  },
  transform(raw) {
    if (raw.pendingConfirm) return raw.confirmMessage;
    if (raw.error) return `操作失败：${raw.message}`;
    if (raw.deleted) {
      if (raw.resourceType === 'tag') return `✅ 标签「${raw.resourceName}」已删除（不可恢复）`;
      if (raw.resourceType === 'bookmark') return `✅ 书签「${raw.resourceName}」已删除，可在回收站找回`;
      if (raw.resourceType === 'note') return `✅ 笔记「${raw.resourceName}」已删除，可在回收站找回`;
      return `✅ 文件「${raw.resourceName}」已删除，30天内可在回收站找回`;
    }
    return '';
  },
  summarize(raw) {
    if (raw.pendingConfirm) return `待确认删除「${raw.resourceName}」`;
    if (raw.deleted) return `已删除「${raw.resourceName}」`;
    return `删除操作：${raw.error || '未知状态'}`;
  },
};
