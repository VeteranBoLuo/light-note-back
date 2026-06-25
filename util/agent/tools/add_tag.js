import pool from '../../../db/index.js';
import { insertData } from '../../../util/common.js';

const VALID_TYPES = ['bookmark', 'note', 'file'];
const TYPE_TABLE_MAP = {
  bookmark: { table: 'bookmark', userIdField: 'user_id' },
  note: { table: 'note', userIdField: 'create_by' },
  file: { table: 'files', userIdField: 'create_by' },
};

export default {
  name: 'add_tag',
  description: '给书签、笔记或文件添加标签。标签不存在会自动创建。支持按资源 ID 或资源名称操作。',
  plannerHint: '当用户想给某个资源打标签时调用。按 resourceId 精确匹配，或按 resourceName 模糊搜索。标签不存在会自动创建。',
  parameters: {
    type: 'object',
    properties: {
      resourceType: { type: 'string', description: '资源类型：bookmark(书签)、note(笔记)、file(文件)' },
      resourceId: { type: 'string', description: '资源 ID，精确匹配。优先于 resourceName' },
      resourceName: { type: 'string', description: '资源名称（标题），模糊匹配。resourceId 未提供时使用' },
      tagName: { type: 'string', description: '要添加的标签名称' },
    },
    required: ['resourceType', 'tagName'],
  },
  requireRoot: false,
  async execute(args, ctx) {
    const { resourceType, resourceId, resourceName, tagName } = args;

    if (!VALID_TYPES.includes(resourceType)) {
      return { error: 'INVALID_TYPE', message: `不支持的资源类型：${resourceType}` };
    }
    if (!tagName?.trim()) {
      return { error: 'TAG_REQUIRED', message: '标签名称不能为空' };
    }

    const cfg = TYPE_TABLE_MAP[resourceType];
    let resourceIdToUse;
    let matchedName;

    if (resourceId?.trim()) {
      // 精确匹配 ID
      resourceIdToUse = resourceId.trim();
      const [resources] = await pool.query(
        `SELECT id, ${resourceType === 'file' ? 'file_name' : resourceType === 'note' ? 'title' : 'name'} AS name
         FROM \`${cfg.table}\` WHERE id = ? AND ${cfg.userIdField} = ? AND del_flag = 0`,
        [resourceIdToUse, ctx.userId],
      );
      if (resources.length === 0) {
        return { error: 'NOT_FOUND', message: `未找到该${resourceType}，或不属于当前用户` };
      }
      matchedName = resources[0].name;
    } else if (resourceName?.trim()) {
      // 按名称模糊搜索
      const [resources] = await pool.query(
        `SELECT id, ${resourceType === 'file' ? 'file_name' : resourceType === 'note' ? 'title' : 'name'} AS name
         FROM \`${cfg.table}\`
         WHERE ${cfg.userIdField} = ? AND del_flag = 0 AND ${resourceType === 'file' ? 'file_name' : resourceType === 'note' ? 'title' : 'name'} LIKE ?
         ORDER BY create_time DESC LIMIT 1`,
        [ctx.userId, `%${resourceName.trim()}%`],
      );
      if (resources.length === 0) {
        return { error: 'NOT_FOUND', message: `未找到名称包含"${resourceName.trim()}"的${resourceType}` };
      }
      resourceIdToUse = resources[0].id;
      matchedName = resources[0].name;
    } else {
      return { error: 'NO_TARGET', message: '请提供 resourceId 或 resourceName 指定要操作的资源' };
    }

    // 查找或创建标签
    const [existingTags] = await pool.query(
      'SELECT id FROM tag WHERE user_id = ? AND name = ? AND del_flag = 0',
      [ctx.userId, tagName.trim()],
    );

    let tagId;
    let isNewTag = false;

    if (existingTags.length > 0) {
      tagId = existingTags[0].id;
    } else {
      const tagData = insertData({ name: tagName.trim(), userId: ctx.userId });
      await pool.query('INSERT INTO tag SET ?', [tagData]);
      tagId = tagData.id;
      isNewTag = true;
    }

    const [existingRelations] = await pool.query(
      'SELECT tag_id FROM resource_tag_relations WHERE tag_id = ? AND resource_type = ? AND resource_id = ? AND user_id = ?',
      [tagId, resourceType, resourceIdToUse, ctx.userId],
    );

    if (existingRelations.length > 0) {
      return { tagName: tagName.trim(), resourceName: matchedName, resourceType, alreadyTagged: true, isNewTag };
    }

    await pool.query(
      'INSERT INTO resource_tag_relations (tag_id, resource_type, resource_id, user_id) VALUES (?, ?, ?, ?)',
      [tagId, resourceType, resourceIdToUse, ctx.userId],
    );

    return { tagName: tagName.trim(), resourceName: matchedName, resourceType, alreadyTagged: false, isNewTag };
  },
  transform(raw) {
    if (raw.error) return `操作失败：${raw.message}`;
    if (raw.alreadyTagged) {
      return `「${raw.tagName}」标签已存在于「${raw.resourceName}」上${raw.isNewTag ? '（已自动创建该标签）' : ''}`;
    }
    return `✅ 已为「${raw.resourceName}」添加标签「${raw.tagName}」${raw.isNewTag ? '（已自动创建该标签）' : ''}`;
  },
  summarize(raw) {
    if (raw.error) return `加标签失败：${raw.message}`;
    if (raw.alreadyTagged) return `加标签「${raw.tagName}」：已存在`;
    return `加标签「${raw.tagName}」成功${raw.isNewTag ? '（新标签）' : ''}`;
  },
};
