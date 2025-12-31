import pool from '../db/index.js';
import { resultData, snakeCaseKeys, mergeExistingProperties, generateUUID } from '../util/common.js';

import { promises as fs } from 'fs';
import path from 'path';
export const queryTagList = (req, res) => {
  const userId = req.headers['x-user-id'];
  try {
    let sql = `SELECT 
    t.*,
    (
        SELECT JSON_ARRAYAGG(
            JSON_OBJECT(
                'id', b.id,
                'name', b.name,
                'url',b.url
            )
        )
        FROM bookmark b
        INNER JOIN tag_bookmark_relations tb ON b.id = tb.bookmark_id
        WHERE tb.tag_id = t.id AND b.del_flag = 0
    ) AS bookmarkList,COALESCE(
        (
            SELECT JSON_ARRAYAGG(
                JSON_OBJECT(
                    'id', related.id,
                    'name', related.name
                )
            )
            FROM tag_relations ta
            INNER JOIN tag related ON ta.related_tag_id = related.id
            WHERE ta.tag_id = t.id
        ),
        JSON_ARRAY()
    ) AS relatedTagList
FROM 
    tag t
    LEFT JOIN tag_relations ta ON t.id = ta.tag_id
      WHERE
      t.user_id = ? AND t.del_flag = 0
      GROUP BY 
    t.id
      ORDER BY
      t.sort, 
      t.create_time DESC;
`;
    pool
      .query(sql, [userId])
      .then(([result]) => {
        const tagsWithBookmarks = result.map((tag) => {
          // 将bookmarkList字段中的JSON字符串转换为数组
          const bookmarkList = tag.bookmarkList ? tag.bookmarkList : [];

          // 返回新的tag对象，包含bookmarkList数组
          return {
            ...tag,
            bookmarkList: bookmarkList,
          };
        });
        res.send(resultData(tagsWithBookmarks));
      })
      .catch((e) => {
        return res.send(resultData(null, 500, '服务器内部错误: ' + e));
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e)); // 设置状态码为400
  }
};
export const getRelatedTag = (req, res) => {
  const userId = req.headers['x-user-id'];
  try {
    let sql = `SELECT t.* FROM tag t LEFT JOIN tag_relations a on t.id=a.related_tag_id 
WHERE t.user_id=? AND a.tag_id=? AND t.del_flag=0`;
    if (req.body.filters.type === 'bookmark') {
      sql = `SELECT t.* FROM tag t LEFT JOIN tag_bookmark_relations tb on t.id=tb.tag_id 
WHERE t.user_id=? AND tb.bookmark_id=? AND t.del_flag=0`;
    }
    pool
      .query(sql, [userId, req.body.filters.id])
      .then(([result]) => {
        res.send(resultData(result));
      })
      .catch((e) => {
        return res.send(resultData(null, 500, '服务器内部错误: ' + e));
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e)); // 设置状态码为400
  }
};

export const updateTagSort = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction(); // 开始事务
    const { tags } = req.body;
    for (const tag of tags) {
      const { id, sort } = tag;
      const sql = 'UPDATE tag SET sort = ? WHERE id = ?';
      await pool.query(sql, [sort, id]);
    }
    await connection.commit(); // 提交事务
    res.send(resultData(null, 200, 'Sort updated successfully'));
  } catch (e) {
    await connection.rollback(); // 如果发生错误，回滚事务
    res.send(resultData(null, 500, '服务器内部错误' + e)); // 设置状态码为400
  } finally {
    connection.release(); // 释放连接回连接池
  }
};

export const getTagDetail = (req, res) => {
  try {
    const { filters } = req.body;
    pool
      .query(`SELECT * FROM tag WHERE  id=? AND del_flag=0`, [filters.id])
      .then(([result]) => {
        if (result.length === 0) {
          throw '标签不存在';
        }
        res.send(resultData(result[0]));
      })
      .catch((e) => {
        return res.send(resultData(null, 500, '服务器内部错误: ' + e));
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e)); // 设置状态码为400
  }
};

export const addTag = async (req, res) => {
  try {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction(); // 开始事务
      const userId = req.headers['x-user-id'];
      const params = {
        ...req.body,
        createTime: req.requestTime,
        userId: userId,
      };
      const sqlCheck = 'SELECT * FROM tag WHERE user_id=? AND name = ? AND del_flag = 0';
      const [checkRes] = await connection.query(sqlCheck, [userId, params.name]);
      if (checkRes.length > 0) {
        throw new Error('标签已存在');
      }
      // 插入新的标签
      let sql = `INSERT INTO Tag SET ?`;
      const [insertResult] = await connection.query(sql, [
        mergeExistingProperties(snakeCaseKeys(params), [undefined, '', []], ['related_tag_ids', 'bookmark_list']),
      ]);
      // 处理关联标签数量限制
      const { relatedTagIds, bookmarkList } = req.body;
      if (relatedTagIds && relatedTagIds.length > 4) {
        throw new Error('最多选择4个相关标签');
      }
      // 获取新插入的标签ID
      const getTagSql = `SELECT id FROM Tag ORDER BY create_time DESC LIMIT 1`;
      const [tagResult] = await connection.query(getTagSql);
      const insertedTagId = tagResult[0].id;
      // 如果有相关标签，则插入新的关联
      if (relatedTagIds && relatedTagIds.length > 0) {
        for (const relatedTagId of relatedTagIds) {
          const insertAssociationSql = `INSERT INTO tag_relations (tag_id, related_tag_id) VALUES (?, ?), (?, ?)`;
          await connection.query(insertAssociationSql, [insertedTagId, relatedTagId, relatedTagId, insertedTagId]);
        }
      }

      // 如果有书签列表，则插入新的关联
      if (bookmarkList && bookmarkList.length > 0) {
        const bookmarkIds = bookmarkList;
        const insertBookmarkRelationsSql = `INSERT INTO tag_bookmark_relations (tag_id, bookmark_id) VALUES ?`;
        const bookmarkValues = bookmarkIds.map((bookmarkId) => [insertedTagId, bookmarkId]);
        await connection.query(insertBookmarkRelationsSql, [bookmarkValues]);
      }
      await connection.commit(); // 提交事务
      res.send(resultData(insertResult)); // 发送成功响应
    } catch (error) {
      await connection.rollback(); // 回滚事务
      res.send(resultData(null, 500, '服务器内部错误: ' + error.message)); // 设置状态码为500
    } finally {
      connection.release(); // 释放连接
    }
  } catch (error) {
    res.send(resultData(null, 400, '客户端请求异常: ' + error.message)); // 设置状态码为400
  }
};

export const delTag = (req, res) => {
  try {
    const id = req.body.id; // 获取标签ID
    let sql = `UPDATE TAG SET del_flag=1  WHERE id=?`;
    pool
      .query(sql, [id])
      .then(([result]) => {
        res.send(resultData(result));
      })
      .catch((e) => {
        return res.send(resultData(null, 500, '服务器内部错误: ' + e));
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e)); // 设置状态码为400
  }
};

export const updateTag = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction(); // 开始事务
    const { relatedTagIds, id: id1, bookmarkList } = req.body;
    const id = id1; // 获取标签ID
    const paramsData = JSON.parse(JSON.stringify(req.body));
    const params = {
      name: paramsData.name,
      iconUrl: paramsData.iconUrl,
    };
    const userId = req.headers['x-user-id'];
    const sqlCheck = 'SELECT * FROM tag WHERE user_id=? AND name = ? AND del_flag = 0';
    const [checkRes] = await connection.query(sqlCheck, [userId, params.name]);
    if (checkRes.length > 0 && checkRes[0].id !== id) {
      throw new Error('标签已存在');
    }

    if (relatedTagIds && relatedTagIds.length > 4) {
      throw new Error('最多选择4个相关标签');
    }
    // 更新tag表
    const updateTagSql = `UPDATE tag SET ? WHERE id = ?`;
    const [updateResult] = await connection.query(updateTagSql, [snakeCaseKeys(mergeExistingProperties(params)), id]);
    // 只要传了relatedTagIds，就需要重新处理
    if (relatedTagIds !== undefined) {
      // 清空所有关联
      const deleteAssociationsSql = `DELETE FROM tag_relations WHERE tag_id = ? OR related_tag_id = ?`;
      await connection.query(deleteAssociationsSql, [id, id]);

      // 如果有相关标签，则插入新的关联
      if (relatedTagIds) {
        for (const relatedTagId of relatedTagIds) {
          const insertAssociationSql = `INSERT INTO tag_relations (tag_id, related_tag_id) VALUES (?, ?), (?, ?)`;
          await connection.query(insertAssociationSql, [id, relatedTagId, relatedTagId, id]);
        }
      }
    }

    // 只要传了bookmarkList，就需要重新处理
    if (bookmarkList !== undefined) {
      // 清空标签和书签的关联
      const deleteBookmarkRelationsSql = `DELETE FROM tag_bookmark_relations WHERE tag_id = ?`;
      await connection.query(deleteBookmarkRelationsSql, [id]);
      // 如果有书签列表，则插入新的关联
      if (bookmarkList && bookmarkList.length > 0) {
        const bookmarkIds = bookmarkList;
        const insertBookmarkRelationsSql = `INSERT INTO tag_bookmark_relations (tag_id, bookmark_id) VALUES ?`;
        const bookmarkValues = bookmarkIds.map((bookmarkId) => [id, bookmarkId]);
        await connection.query(insertBookmarkRelationsSql, [bookmarkValues]);
      }
    }

    await connection.commit(); // 提交事务
    res.send(resultData(updateResult)); // 发送成功响应
  } catch (error) {
    await connection.rollback(); // 回滚事务
    res.send(resultData(null, 500, '服务器内部错误: ' + error.message)); // 设置状态码为500
  } finally {
    await connection.release(); // 释放连接
  }
};
export const getBookmarkList = (req, res) => {
  const userId = req.headers['x-user-id']; // 获取用户ID
  const tagId = req.body.filters.tagId; // 获取标签ID
  let sql = `SELECT b.*,(
        SELECT JSON_ARRAYAGG(
            JSON_OBJECT(
                'id', t.id,
                'name', t.name
            )
        )
        FROM tag t
        INNER JOIN tag_bookmark_relations tb ON t.id = tb.tag_id
        WHERE tb.bookmark_id = b.id AND t.del_flag = 0
    ) AS tagList
FROM bookmark b
JOIN tag_bookmark_relations tbr ON b.id = tbr.bookmark_id
WHERE b.user_id=? AND tbr.tag_id = ? AND  b.del_flag=0   ORDER BY b.sort, b.create_time DESC`;
  let params = [userId, tagId];
  const type = req.body.filters.type;
  if (type === 'all') {
    sql = `SELECT 
    b.*,
    (
        SELECT JSON_ARRAYAGG(
            JSON_OBJECT(
                'id', t.id,
                'name', t.name
            )
        )
        FROM tag t
        INNER JOIN tag_bookmark_relations tb ON t.id = tb.tag_id
        WHERE tb.bookmark_id = b.id AND t.del_flag = 0
    ) AS tagList
FROM 
    bookmark b
      WHERE
      b.user_id = ? AND b.del_flag = 0
      ORDER BY
      b.sort, b.create_time DESC;

`;
    params = [userId];
  } else if (type === 'search') {
    sql = `SELECT 
    b.*, 
    (
        SELECT JSON_ARRAYAGG(
            JSON_OBJECT(
                'id', t.id,
                'name', t.name
            )
        )
        FROM tag t
        INNER JOIN tag_bookmark_relations tb ON t.id = tb.tag_id
        WHERE tb.bookmark_id = b.id AND t.del_flag = 0
    ) AS tagList
FROM 
    bookmark b
LEFT JOIN 
    tag_bookmark_relations tb ON b.id = tb.bookmark_id
LEFT JOIN 
    tag t ON tb.tag_id = t.id AND t.name LIKE CONCAT('%', ?, '%') AND t.del_flag = 0
WHERE 
    b.user_id = ? AND 
    b.del_flag = 0 AND
    (
        b.name LIKE CONCAT('%', ?, '%') OR
        b.description LIKE CONCAT('%', ?, '%') OR
        t.id IS NOT NULL
    )
GROUP BY 

    b.id
ORDER BY 
    b.sort, b.create_time DESC;
`;
    params = [req.body.filters.value, userId, req.body.filters.value, req.body.filters.value];
  }
  pool
    .query(sql, params)
    .then(async ([result]) => {
      const totalSql = `SELECT COUNT(*) FROM bookmark WHERE user_id=? and del_flag = 0`;
      const [totalRes] = await pool.query(totalSql, [userId]);
      res.send(
        resultData({
          items: result,
          total: totalRes[0]['COUNT(*)'],
        }),
      );
    })
    .catch((e) => {
      res.send(resultData(null, 400, '客户端请求异常' + e)); // 设置状态码为400
    });
};

export const addBookmark = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const userId = req.headers['x-user-id'];
    const params = {
      ...req.body,
      createTime: req.requestTime,
      userId: userId,
    };
    const sqlCheck = 'SELECT * FROM bookmark WHERE user_id=? AND name = ? AND del_flag = 0';
    const [checkRes] = await connection.query(sqlCheck, [userId, params.name]);
    if (checkRes.length > 0) {
      throw new Error(`书签${checkRes[0].name}已存在`);
    }

    let sql = `INSERT INTO bookmark SET ?`;
    const [result] = await connection.query(sql, [
      mergeExistingProperties(snakeCaseKeys(params), [undefined, '', []], ['related_tags']),
    ]);

    let getTBookmarkSql = `SELECT * FROM bookmark ORDER BY create_time DESC LIMIT 1`;
    const [bookmarkResult] = await connection.query(getTBookmarkSql);
    const insertBookmarkId = bookmarkResult[0].id;
    if (req.body.relatedTags && req.body.relatedTags.length > 4) {
      throw new Error('最多选择4个关联标签');
    }
    if (req.body.relatedTags && req.body.relatedTags.length > 0) {
      const tagIds = req.body.relatedTags;
      const insertBookmarkRelationsSql = `INSERT INTO tag_bookmark_relations (tag_id, bookmark_id) VALUES ?`;
      const tagValues = tagIds.map((tagId) => [tagId, insertBookmarkId]);
      await connection.query(insertBookmarkRelationsSql, [tagValues]);
    }
    await connection.commit();
    res.send(resultData(result));
  } catch (err) {
    await connection.rollback();
    res.send(resultData(null, 500, err.message)); // 设置状态码为500
  } finally {
    connection.release();
  }
};

export const updateBookmark = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const id = req.body.id;
    const userId = req.headers['x-user-id'];
    const sqlCheck = 'SELECT * FROM bookmark WHERE user_id=? AND name = ? AND del_flag = 0';
    const [checkRes] = await connection.query(sqlCheck, [userId, req.body.name]);
    if (checkRes.length > 0 && checkRes[0].id != id) {
      throw new Error('书签已存在');
    }
    req.body.iconUrl = null;
    const sql = `update bookmark set ? where id=?`;
    const [updateResult] = await connection.query(sql, [
      mergeExistingProperties(snakeCaseKeys(req.body), [], ['related_tags', 'related_tags']),
      id,
    ]);
    // 清空标签和书签的关联
    const deleteBookmarkRelationsSql = `DELETE FROM tag_bookmark_relations WHERE bookmark_id = ?`;
    await connection.query(deleteBookmarkRelationsSql, [id]);
    // 如果有书签列表，则插入新的关联
    if (req.body.relatedTags && req.body.relatedTags.length > 4) {
      throw new Error('最多选择4个关联标签');
    }
    if (req.body.relatedTags && req.body.relatedTags.length > 0) {
      const tagIds = req.body.relatedTags;
      const insertBookmarkRelationsSql = `INSERT INTO tag_bookmark_relations (tag_id, bookmark_id) VALUES ?`;
      const tagValues = tagIds.map((tagId) => [tagId, id]);
      await connection.query(insertBookmarkRelationsSql, [tagValues]);
    }
    await connection.commit(); // 提交事务
    res.send(resultData(updateResult)); // 发送成功响应
  } catch (error) {
    await connection.rollback(); // 回滚事务
    res.send(resultData(null, 500, error.message)); // 设置状态码为500
  } finally {
    await connection.release(); // 释放连接
  }
};

export const getBookmarkDetail = (req, res) => {
  try {
    let sql = `SELECT * FROM bookmark WHERE  id=? AND del_flag=0`;
    pool
      .query(sql, [req.body.filters.id])
      .then(([result]) => {
        if (result.length === 0) {
          throw new Error('书签不存在');
        }
        res.send(resultData(result[0]));
      })
      .catch((e) => {
        return res.send(resultData(null, 500, '服务器内部错误: ' + e.message));
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e)); // 设置状态码为400
  }
};

export const delBookmark = async (req, res) => {
  try {
    const id = req.body.id;

    const [result] = await pool.query(`SELECT * FROM bookmark WHERE id=?`, [id]);
    if (result.length === 0) {
      return res.send(resultData(null, 404, '书签不存在'));
    }

    const iconUrl = result[0].icon_url;

    // 提取文件名
    const url = new URL(iconUrl);
    const fileName = url.pathname.split('/').pop();
    // 构造服务器上的文件路径
    const filePath = path.join('/www/wwwroot/images/', fileName);

    // 删除文件
    try {
      await fs.unlink(filePath);
    } catch (e) {
      console.error('删除文件失败:', e);
    }

    const params = {
      del_flag: 1,
      icon_url: null,
    };

    const [updateResult] = await pool.query(`UPDATE bookmark SET ? WHERE id=?`, [params, id]);

    res.send(resultData(updateResult));
  } catch (e) {
    res.send(resultData(null, 500, '服务器内部错误: ' + e.message));
  }
};

export const getCommonBookmarks = async (req, res) => {
  try {
    const [result] = await pool.query(
      "SELECT REPLACE(operation, '点击书签卡片', '') AS name,COUNT(*) as count FROM `operation_logs` WHERE operation LIKE '点击书签卡片%' GROUP  BY operation ORDER BY count DESC LIMIT 10",
    );
    res.send(
      resultData({
        items: result,
        total: 10,
      }),
    );
  } catch (e) {
    res.send(resultData(e.message, 200));
  }
};

export const updateBookmarkSort = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction(); // 开始事务
    const { bookmarks } = req.body;
    for (const bookmark of bookmarks) {
      const { id, sort } = bookmark;
      const sql = 'UPDATE bookmark SET sort = ? WHERE id = ?';
      await pool.query(sql, [sort, id]);
    }
    await connection.commit(); // 提交事务
    res.send(resultData(null, 200, 'Sort updated successfully'));
  } catch (e) {
    await connection.rollback(); // 如果发生错误，回滚事务
    res.send(resultData(null, 500, '服务器内部错误' + e)); // 设置状态码为400
  } finally {
    connection.release(); // 释放连接回连接池
  }
};

// 解析 Netscape 书签 HTML，提取文件夹（标签）与书签
const parseBookmarksFromHtml = (html = '') => {
  const bookmarks = [];
  const folderStack = [];
  const lines = html.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const folderMatch = line.match(/<DT><H3[^>]*>(.*?)<\/H3>/i);
    if (folderMatch) {
      folderStack.push(folderMatch[1].trim());
      continue;
    }

    if (/<\/DL>/i.test(line) && folderStack.length) {
      folderStack.pop();
      continue;
    }

    const linkMatch = line.match(/<DT><A[^>]*HREF="([^"]+)"[^>]*>(.*?)<\/A>/i);
    if (linkMatch) {
      const currentFolder = folderStack[folderStack.length - 1] || '';
      bookmarks.push({
        name: linkMatch[2].trim(),
        url: linkMatch[1].trim(),
        folder: currentFolder,
      });
    }
  }

  return bookmarks;
};

// HTML 书签导入：新增缺失的标签/书签，并建立关联
export const importBookmarksHtml = async (req, res) => {
  const userId = req.headers['x-user-id'];

  if (!userId) {
    return res.send(resultData(null, 401, '缺少用户身份')); // 无法继续
  }

  if (!req.file) {
    return res.send(resultData(null, 400, '未上传文件'));
  }

  let html;
  try {
    html = await fs.readFile(req.file.path, 'utf8');
  } catch (err) {
    return res.send(resultData(null, 500, '读取文件失败'));
  } finally {
    // 删除临时文件
    try {
      await fs.unlink(req.file.path);
    } catch (e) {
      console.error('删除临时文件失败:', e);
    }
  }

  if (!html || typeof html !== 'string') {
    return res.send(resultData(null, 400, 'html 内容为空'));
  }

  const parsedBookmarks = parseBookmarksFromHtml(html);
  if (!parsedBookmarks.length) {
    return res.send(resultData(null, 400, '未解析到书签数据'));
  }

  console.log(`解析到 ${parsedBookmarks.length} 条书签`, parsedBookmarks);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 预加载现有标签和书签
    const [tagRows] = await connection.query('SELECT id, name FROM tag WHERE user_id = ? AND del_flag = 0', [userId]);
    const [bookmarkRows] = await connection.query('SELECT id, name FROM bookmark WHERE user_id = ? AND del_flag = 0', [
      userId,
    ]);
    const tagMap = new Map(tagRows.map((row) => [row.name, row.id]));
    const bookmarkMap = new Map(bookmarkRows.map((row) => [row.name, row.id]));

    let createdTags = 0;
    let createdBookmarks = 0;
    let boundRelations = 0;

    for (const item of parsedBookmarks) {
      const tagName = (item.folder || '').trim();
      let tagId = null;

      if (tagName) {
        if (!tagMap.has(tagName)) {
          const tagPayload = {
            name: tagName,
            userId,
            createTime: req.requestTime || new Date().toISOString().slice(0, 19).replace('T', ' '),
          };
          const [tagResult] = await connection.query('INSERT INTO tag SET ?', [snakeCaseKeys(tagPayload)]);
          // 支持自增主键或触发器生成 ID 的两种情况
          tagId = tagResult.insertId || tagPayload.id || null;
          // 如果数据库未返回 insertId，说明表使用字符串主键且未自动生成，手动获取刚插入的 id
          if (!tagId) {
            const [[lastInsertedTag]] = await connection.query(
              'SELECT id FROM tag WHERE name = ? AND user_id = ? ORDER BY create_time DESC LIMIT 1',
              [tagName, userId],
            );
            tagId = lastInsertedTag?.id;
          }
          tagMap.set(tagName, tagId);
          createdTags++;
        } else {
          console.log('标签已存在:', tagName);
          tagId = tagMap.get(tagName);
        }
      }
      let bookmarkId = bookmarkMap.get(item.name);
      if (!bookmarkId) {
        const bookmarkPayload = {
          name: item.name,
          userId,
          url: item.url,
          description: '',
          createTime: req.requestTime,
        };
        const [bookmarkResult] = await connection.query('INSERT INTO bookmark SET ?', [snakeCaseKeys(bookmarkPayload)]);
        bookmarkId = bookmarkResult.insertId || bookmarkPayload.id || null;
        if (!bookmarkId) {
          const [[lastInsertedBookmark]] = await connection.query(
            'SELECT id FROM bookmark WHERE name = ? AND user_id = ? ORDER BY create_time DESC LIMIT 1',
            [item.name, userId],
          );
          bookmarkId = lastInsertedBookmark?.id;
        }
        bookmarkMap.set(item.name, bookmarkId);
        createdBookmarks++;
      }
      if (tagId && bookmarkId) {
        // 检查关联是否已存在
        const [existingRelation] = await connection.query(
          'SELECT 1 FROM tag_bookmark_relations WHERE tag_id = ? AND bookmark_id = ?',
          [tagId, bookmarkId],
        );
        if (existingRelation.length === 0) {
          const [relationResult] = await connection.query(
            `INSERT INTO tag_bookmark_relations (tag_id, bookmark_id) VALUES (?, ?)`,
            [tagId, bookmarkId],
          );
          if (relationResult.affectedRows > 0) {
            boundRelations++;
          }
        }
      }
    }

    await connection.commit();
    res.send(
      resultData({
        parsedTotal: parsedBookmarks.length,
        createdTags,
        createdBookmarks,
        boundRelations,
      }),
    );
  } catch (e) {
    await connection.rollback();
    res.send(resultData(null, 500, '服务器内部错误: ' + e.message));
  } finally {
    connection.release();
  }
};
