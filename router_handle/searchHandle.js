import pool from '../db/index.js';
import { resultData } from '../util/common.js';
import { resolveFileCategory } from '../util/fileCategory.js';

const SEARCH_TYPES = ['bookmark', 'note', 'file', 'tag'];
const TYPE_LABELS = {
  bookmark: '书签',
  note: '笔记',
  file: '文件',
  tag: '标签',
};

const FILE_CATEGORY_LABELS = {
  'zh-CN': {
    image: '图片',
    video: '视频',
    audio: '音频',
    pdf: 'PDF',
    word: 'Word',
    excel: 'Excel',
    ppt: 'PPT',
    text: '文本',
    compress: '压缩包',
    other: '其他',
  },
  'en-US': {
    image: 'Image',
    video: 'Video',
    audio: 'Audio',
    pdf: 'PDF',
    word: 'Word',
    excel: 'Excel',
    ppt: 'PPT',
    text: 'Text',
    compress: 'Compress',
    other: 'Other',
  },
};

function toText(value) {
  return String(value ?? '').trim();
}

function stripHtml(value) {
  return toText(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeDate(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = toText(value);
  return text.length > 10 ? text.slice(0, 10) : text;
}

function normalizeLimit(value, fallback = 12, max = 50) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function groupItems(items) {
  return SEARCH_TYPES.map((type) => ({
    type,
    label: TYPE_LABELS[type],
    items: items.filter((item) => item.type === type),
  })).filter((group) => group.items.length > 0);
}

function buildLike(keyword) {
  return `%${keyword}%`;
}

function normalizeLang(value) {
  return value === 'en-US' ? 'en-US' : 'zh-CN';
}

function formatFileSizeMb(value) {
  if (!value) return '';
  return `${(Number(value) / 1024 / 1024).toFixed(2)} MB`;
}

function formatFileSearchExtra(item, lang) {
  const category = resolveFileCategory({
    fileName: item.file_name,
    fileType: item.file_type,
  });
  const categoryLabel = FILE_CATEGORY_LABELS[normalizeLang(lang)][category] || FILE_CATEGORY_LABELS['zh-CN'].other;
  const size = formatFileSizeMb(item.file_size);
  return [categoryLabel, size].filter(Boolean).join(' · ');
}

async function queryBookmarks(userId, keyword, limit) {
  const like = buildLike(keyword);
  const hasKeyword = keyword.length > 0;
  const sql = `
    SELECT
      b.*,
      (
        SELECT JSON_ARRAYAGG(JSON_OBJECT('id', t.id, 'name', t.name))
        FROM tag t
        INNER JOIN tag_bookmark_relations tb ON t.id = tb.tag_id
        WHERE tb.bookmark_id = b.id AND t.del_flag = 0
      ) AS tag_list
    FROM bookmark b
    WHERE b.user_id = ?
      AND b.del_flag = 0
      AND (
        ? = 0
        OR b.name LIKE ?
        OR b.description LIKE ?
        OR b.url LIKE ?
        OR EXISTS (
          SELECT 1
          FROM tag_bookmark_relations tb2
          INNER JOIN tag t2 ON tb2.tag_id = t2.id
          WHERE tb2.bookmark_id = b.id
            AND t2.del_flag = 0
            AND t2.name LIKE ?
        )
      )
    ORDER BY b.sort, b.create_time DESC
    LIMIT ?
  `;
  const [rows] = await pool.query(sql, [userId, hasKeyword ? 1 : 0, like, like, like, like, limit]);
  return rows.map((item) => ({
    id: toText(item.id),
    type: 'bookmark',
    title: toText(item.name) || '未命名书签',
    description: toText(item.description) || toText(item.url),
    extra: Array.isArray(item.tag_list) ? item.tag_list.map((tag) => `#${tag.name}`).join(' ') : '',
    url: toText(item.url),
    route: '/home',
    iconUrl: item.icon_url || (item.url ? `https://icon.bqb.cool?url=${item.url}` : ''),
    raw: item,
  }));
}

async function queryNotes(userId, keyword, limit) {
  const like = buildLike(keyword);
  const hasKeyword = keyword.length > 0;
  const sql = `
    SELECT
      n.*,
      (
        SELECT JSON_ARRAYAGG(JSON_OBJECT('id', nt.id, 'name', nt.name))
        FROM note_tag_relations ntr
        INNER JOIN note_tags nt ON ntr.tag_id = nt.id
        WHERE ntr.note_id = n.id
      ) AS tags
    FROM note n
    WHERE n.create_by = ?
      AND n.del_flag = 0
      AND (? = 0 OR n.title LIKE ? OR n.content LIKE ?)
    ORDER BY n.sort, n.update_time DESC
    LIMIT ?
  `;
  const [rows] = await pool.query(sql, [userId, hasKeyword ? 1 : 0, like, like, limit]);
  return rows.map((item) => ({
    id: toText(item.id),
    type: 'note',
    title: toText(item.title) || '未命名文档',
    description: stripHtml(item.content).slice(0, 140) || '打开笔记查看正文内容',
    extra: normalizeDate(item.update_time || item.create_time),
    route: `/noteLibrary/${item.id}`,
    raw: item,
  }));
}

async function queryFiles(userId, keyword, limit, lang) {
  const like = buildLike(keyword);
  const hasKeyword = keyword.length > 0;
  const sql = `
    SELECT files.*, folders.name AS folder_name
    FROM files
    LEFT JOIN folders ON files.folder_id = folders.id
    WHERE files.create_by = ?
      AND files.del_flag = 0
      AND (? = 0 OR files.file_name LIKE ? OR files.file_type LIKE ? OR folders.name LIKE ?)
    ORDER BY files.create_time DESC
    LIMIT ?
  `;
  const [rows] = await pool.query(sql, [userId, hasKeyword ? 1 : 0, like, like, like, limit]);
  return rows.map((item) => ({
    id: toText(item.id),
    type: 'file',
    title: toText(item.file_name) || '未命名文件',
    description: item.folder_name ? `位于 ${item.folder_name}` : '云空间文件',
    category: resolveFileCategory({
      fileName: item.file_name,
      fileType: item.file_type,
    }),
    extra: formatFileSearchExtra(item, lang),
    route: '/cloudSpace',
    raw: item,
  }));
}

async function queryTags(userId, keyword, limit) {
  const like = buildLike(keyword);
  const hasKeyword = keyword.length > 0;
  const sql = `
    SELECT t.*, COUNT(b.id) AS bookmark_count
    FROM tag t
    LEFT JOIN tag_bookmark_relations tb ON t.id = tb.tag_id
    LEFT JOIN bookmark b ON tb.bookmark_id = b.id AND b.del_flag = 0
    WHERE t.user_id = ?
      AND t.del_flag = 0
      AND (? = 0 OR t.name LIKE ?)
    GROUP BY t.id
    ORDER BY t.sort, t.create_time DESC
    LIMIT ?
  `;
  const [rows] = await pool.query(sql, [userId, hasKeyword ? 1 : 0, like, limit]);
  return rows.map((item) => ({
    id: toText(item.id),
    type: 'tag',
    title: `#${toText(item.name) || '未命名标签'}`,
    description: '查看该标签下关联的书签与内容',
    extra: `${Number(item.bookmark_count || 0)} 个关联书签`,
    route: `/home/${item.id}`,
    iconUrl: item.icon_url,
    raw: item,
  }));
}

export const globalSearch = async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.send(resultData(null, 400, '缺少用户信息'));

    const keyword = toText(req.body?.keyword || req.body?.filters?.keyword);
    const limitPerType = normalizeLimit(req.body?.limitPerType || req.body?.pageSize, 12);
    const lang = normalizeLang(req.headers['x-lang']);

    const [bookmarks, notes, files, tags] = await Promise.all([
      queryBookmarks(userId, keyword, limitPerType),
      queryNotes(userId, keyword, limitPerType),
      queryFiles(userId, keyword, limitPerType, lang),
      queryTags(userId, keyword, limitPerType),
    ]);

    const items = [...bookmarks, ...notes, ...files, ...tags];
    res.send(
      resultData({
        keyword,
        items,
        groups: groupItems(items),
        total: items.length,
      }),
    );
  } catch (error) {
    console.error('统一搜索失败:', error);
    res.send(resultData(null, 500, '统一搜索失败: ' + error.message));
  }
};
