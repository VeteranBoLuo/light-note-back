import pool from '../db/index.js';
import fs from 'fs/promises';
import path from 'path';
import { snakeCaseKeys, resultData, mergeExistingProperties } from '../util/common.js';
import { RESOURCE_TYPE, replaceResourceTagRelations, validateUserTags } from '../util/resourceTags.js';

export const addNote = (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const params = {
      ...req.body,
      createBy: userId,
    };
    pool
      .query('INSERT INTO note SET ?', [snakeCaseKeys(params)])
      .then(() => {
        pool
          .query('SELECT id FROM note ORDER BY create_time DESC LIMIT 1')
          .then(([noteRes]) => {
            res.send(
              resultData({
                id: noteRes[0]['id'],
              }),
            );
          })
          .catch((err) => {
            res.send(resultData(null, 500, '服务器内部错误: ' + err.message));
          });
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误: ' + err.message));
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e));
  }
};

export const updateNote = async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const params = {
      ...req.body,
      updateBy: userId,
    };
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      // 更新 note 表，排除 tags
      const updateParams = mergeExistingProperties(params, [], ['id', 'tags']);
      await connection.query('update note set ? where id=?', [snakeCaseKeys(updateParams), req.body.id]);
      if (params.tags && Array.isArray(params.tags)) {
        const tagIds = await validateUserTags(connection, { tagIds: params.tags, userId });
        await replaceResourceTagRelations(connection, {
          tagIds,
          resourceType: RESOURCE_TYPE.NOTE,
          resourceId: req.body.id,
          userId,
        });
      }
      await connection.commit();
      res.send(resultData('更新笔记成功'));
    } catch (error) {
      await connection.rollback();
      res.send(resultData(null, 500, '服务器内部错误: ' + error.message));
    } finally {
      connection.release();
    }
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e));
  }
};

export const queryNoteList = (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const tagId = req.body.tagId;
    let sql = `SELECT n.*,
          (
            SELECT JSON_ARRAYAGG(JSON_OBJECT('id', t.id, 'name', t.name))
            FROM resource_tag_relations r
            INNER JOIN tag t ON r.tag_id = t.id
            WHERE r.resource_type = 'note'
              AND r.resource_id = n.id
              AND t.del_flag = 0
          ) AS tags
         FROM note n
         WHERE n.create_by = ? AND n.del_flag = 0`;
    const params = [userId];
    if (tagId) {
      sql += ` AND n.id IN (SELECT resource_id FROM resource_tag_relations WHERE tag_id = ? AND resource_type = 'note')`;
      params.push(tagId);
    }
    sql += ` GROUP BY n.id ORDER BY n.sort, n.update_time DESC`;
    pool
      .query(sql, params)
      .then(([result]) => {
        // 处理 tags 为数组，如果 NULL 或包含无效标签则为空数组
        result.forEach((note) => {
          note.tags =
            note.tags && Array.isArray(note.tags) && note.tags.every((tag) => tag && tag.id !== null) ? note.tags : [];
        });
        res.send(resultData(result));
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误: ' + err.message));
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e));
  }
};

export const getNoteDetail = (req, res) => {
  try {
    pool
      .query('select * from note where id=?', [req.body.id])
      .then(([result]) => {
        res.send(resultData(result[0]));
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误: ' + err.message));
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e));
  }
};

export const delNote = async (req, res) => {
  try {
    const ids = req.body.ids; // 获取标签ID数组
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.send(resultData(null, 400, '无效的请求参数'));
    }

    const sql = `UPDATE note SET del_flag=1 WHERE id IN (?)`;
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction(); // 开始事务

      // 批量更新笔记的 del_flag
      const [updateResult] = await connection.query(sql, [ids]);

      // 查询所有关联的图片URLs
      const selectImagesSql = `SELECT url FROM note_images WHERE note_id IN (?)`;
      const [images] = await connection.query(selectImagesSql, [ids]);
      // 删除笔记关联的图片记录
      const deleteAssociationsSql = `DELETE FROM note_images WHERE note_id IN (?)`;
      await connection.query(deleteAssociationsSql, [ids]);

      // 删除服务器上的图片文件
      const deletePromises = images.map(async (image) => {
        // 替换URL中的代理路径为实际文件路径
        const filePath = image.url.replace(
          new RegExp(`^${req.protocol}://${req.get('host')}/uploads/`),
          '/www/wwwroot/images/',
        );
        try {
          console.log('delete filePath', filePath);
          await fs.unlink(filePath);
        } catch (e) {
          console.error(`删除文件 ${filePath} 时出错: ${e.message}`);
        }
      });

      // 等待所有文件删除操作完成
      await Promise.all(deletePromises);

      await connection.commit(); // 提交事务

      res.send(resultData(updateResult));
    } catch (error) {
      await connection.rollback(); // 回滚事务
      res.send(resultData(null, 500, '服务器内部错误: ' + error.message));
    } finally {
      connection.release(); // 释放连接
    }
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常: ' + e.message)); // 设置状态码为400
  }
};

export const updateNoteSort = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction(); // 开始事务
    const { notes } = req.body;
    for (const note of notes) {
      const { id, sort } = note;
      const sql = 'UPDATE note SET sort = ?, update_time = update_time WHERE id = ?';
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

export const addNoteTag = async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const name = String(req.body.name || '').trim();
    if (!name) {
      return res.send(resultData(null, 400, '标签名称不能为空'));
    }
    const params = {
      name,
      userId: userId,
    };
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [checkRes] = await connection.query('SELECT id FROM tag WHERE user_id = ? AND name = ? AND del_flag = 0', [
        userId,
        name,
      ]);
      if (checkRes.length > 0) {
        throw new Error('标签已存在');
      }
      await connection.query('INSERT INTO tag SET ?', [snakeCaseKeys(params)]);
      const [[createdTag]] = await connection.query(
        'SELECT id, name FROM tag WHERE user_id = ? AND name = ? AND del_flag = 0 ORDER BY create_time DESC LIMIT 1',
        [userId, name],
      );
      await connection.commit();
      res.send(resultData(createdTag || '添加标签成功'));
    } catch (err) {
      await connection.rollback();
      res.send(resultData(null, 500, '服务器内部错误: ' + err.message));
    } finally {
      connection.release();
    }
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e));
  }
};

export const editNoteTag = async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const name = String(req.body.name || '').trim();
    if (!name) {
      return res.send(resultData(null, 400, '标签名称不能为空'));
    }
    const params = {
      name,
    };
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [checkRes] = await connection.query('SELECT id FROM tag WHERE user_id = ? AND name = ? AND del_flag = 0', [
        userId,
        name,
      ]);
      if (checkRes.length > 0 && checkRes[0].id !== req.body.id) {
        throw new Error('标签已存在');
      }
      const [result] = await connection.query('update tag set ? where id=? and user_id=?', [
        snakeCaseKeys(mergeExistingProperties(params, [], ['id'])),
        req.body.id,
        userId,
      ]);
      await connection.commit();
      res.send(resultData(result));
    } catch (err) {
      await connection.rollback();
      res.send(resultData(null, 500, '服务器内部错误: ' + err.message));
    } finally {
      connection.release();
    }
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e));
  }
};

export const queryNoteTagList = (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    pool
      .query(
        `
          SELECT
            t.*,
            (
              SELECT COUNT(*)
              FROM resource_tag_relations r
              INNER JOIN note n ON n.id = r.resource_id AND n.del_flag = 0
              WHERE r.tag_id = t.id AND r.resource_type = 'note'
            ) AS noteCount
          FROM tag t
          WHERE t.user_id = ? AND t.del_flag = 0
          ORDER BY t.sort, t.create_time DESC
        `,
        [userId],
      )
      .then(([result]) => {
        res.send(resultData(result));
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误: ' + err.message));
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e));
  }
};

export const getNoteTags = (req, res) => {
  try {
    const noteId = req.body.id;
    pool
      .query(
        `SELECT t.*
         FROM tag t
         JOIN resource_tag_relations r ON t.id = r.tag_id
         WHERE r.resource_type = 'note' AND r.resource_id = ? AND t.del_flag = 0
         ORDER BY t.sort, t.create_time DESC`,
        [noteId],
      )
      .then(([result]) => {
        res.send(resultData(result));
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误: ' + err.message));
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e));
  }
};

export const delNoteTag = (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const tagId = req.body.id;
    pool
      .query('UPDATE tag SET del_flag = 1 WHERE id = ? AND user_id = ?', [tagId, userId])
      .then(() => {
        res.send(resultData('删除标签成功'));
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误: ' + err.message));
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e));
  }
};

export const updateNoteTags = async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { noteId, tags } = req.body;
    if (!noteId || !Array.isArray(tags)) {
      return res.send(resultData(null, 400, '参数错误'));
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      // 验证笔记属于用户
      const [noteResult] = await connection.query('SELECT id FROM note WHERE id = ? AND create_by = ?', [
        noteId,
        userId,
      ]);
      if (noteResult.length === 0) {
        await connection.rollback();
        return res.send(resultData(null, 403, '无权限操作此笔记'));
      }
      // 验证所有标签属于用户
      if (tags.length > 0) {
        await validateUserTags(connection, { tagIds: tags, userId });
      }
      await replaceResourceTagRelations(connection, {
        tagIds: tags,
        resourceType: RESOURCE_TYPE.NOTE,
        resourceId: noteId,
        userId,
      });
      await connection.commit();
      res.send(resultData('更新标签成功'));
    } catch (error) {
      await connection.rollback();
      res.send(resultData(null, 500, '服务器内部错误: ' + error.message));
    } finally {
      connection.release();
    }
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e));
  }
};
