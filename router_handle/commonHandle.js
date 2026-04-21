import { resultData, snakeCaseKeys } from '../util/common.js';
import https from 'https';
import fs from 'fs';
import fsP from 'fs/promises';
import path from 'path';
import pool from '../db/index.js';
import { validateQueryParams } from '../util/request.js';

const ensureRootRole = async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) {
      res.send(resultData(null, 403, '无权限操作'));
      return null;
    }
    const [userResult] = await pool.query('SELECT role,del_flag FROM user WHERE id = ? LIMIT 1', [userId]);
    if (userResult.length === 0 || Number(userResult[0].del_flag) === 1 || userResult[0].role !== 'root') {
      res.send(resultData(null, 403, '仅root用户可操作'));
      return null;
    }
    return userId;
  } catch (e) {
    res.send(resultData(null, 500, '服务器内部错误: ' + e.message));
    return null;
  }
};

const ensureSortColumn = async (connection, tableName) => {
  const [columnRows] = await connection.query(`SHOW COLUMNS FROM \`${tableName}\` LIKE 'sort'`);
  if (columnRows.length > 0) {
    return false;
  }
  try {
    await connection.query(`ALTER TABLE \`${tableName}\` ADD COLUMN sort INT NOT NULL DEFAULT 0`);
  } catch (e) {
    if (e?.code === 'ER_DUP_FIELDNAME') return false;
    throw e;
  }
  return true;
};

const reseedSortById = async (connection, tableName) => {
  await connection.query('SET @help_sort_seed := -1');
  await connection.query(
    `UPDATE \`${tableName}\`
     SET sort = (@help_sort_seed := @help_sort_seed + 1)
     ORDER BY id ASC`,
  );
};

let helpSortReady = false;
const ensureHelpSortReady = async () => {
  if (helpSortReady) {
    return;
  }
  const connection = await pool.getConnection();
  try {
    const addedHelpSort = await ensureSortColumn(connection, 'help_config');
    if (addedHelpSort) {
      await reseedSortById(connection, 'help_config');
    }
    const addedDraftSort = await ensureSortColumn(connection, 'help_config_draft');
    if (addedDraftSort) {
      await reseedSortById(connection, 'help_config_draft');
    }
    helpSortReady = true;
  } finally {
    connection.release();
  }
};

export const getApiLogs = (req, res) => {
  try {
    const { filters, pageSize, currentPage } = validateQueryParams(req.body);
    const skip = pageSize * (currentPage - 1);
    let sql = `SELECT a.*,u.alias,u.email 
      FROM api_logs a left join user u on a.user_id=u.id  where (u.alias LIKE CONCAT('%', ?, '%') 
      OR a.ip LIKE CONCAT('%', ?, '%') OR a.url LIKE CONCAT('%', ?, '%')) AND a.del_flag=0  
      ORDER BY a.request_time DESC LIMIT ? OFFSET ?`;
    pool
      .query(sql, [filters.key, filters.key, filters.key, pageSize, skip])
      .then(async ([result]) => {
        result.forEach((row) => {
          const fieldsToParse = ['req', 'system', 'location'];
          fieldsToParse.forEach((field) => {
            if (row[field] && typeof row[field] === 'string') {
              try {
                row[field] = JSON.parse(row[field]);
              } catch (e) {
                console.error(`JSON解析失败 ${field}:${row[field]}--`, e);
              }
            }
          });
        });
        const [totalRes] = await pool.query(
          "SELECT COUNT(*) FROM api_logs a left join user u on a.user_id=u.id where (u.alias LIKE CONCAT('%', ?, '%') OR a.url LIKE CONCAT('%', ?, '%')) AND a.del_flag=0",
          [filters.key, filters.key],
        );
        res.send(
          resultData({
            items: result,
            total: totalRes[0]['COUNT(*)'],
          }),
        );
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误: ' + err.message));
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常：' + e.message));
  }
};
export const clearApiLogs = (req, res) => {
  pool
    .query('UPDATE api_logs set del_flag=1')
    .then(() => {
      res.send(resultData(null));
    })
    .catch((err) => {
      res.send(resultData(null, 500, '服务器内部错误: ' + err.message));
    });
};
export const getAttackLogs = (req, res) => {
  try {
    const { filters, pageSize, currentPage } = validateQueryParams(req.body);
    const skip = pageSize * (currentPage - 1);
    let sql = `SELECT * FROM attack_logs WHERE attack_type LIKE CONCAT('%', ?, '%') OR source_ip LIKE CONCAT('%', ?, '%') ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    pool
      .query(sql, [filters.key, filters.key, pageSize, skip])
      .then(async ([result]) => {
        const [totalRes] = await pool.query(
          "SELECT COUNT(*) FROM attack_logs WHERE attack_type LIKE CONCAT('%', ?, '%') OR source_ip LIKE CONCAT('%', ?, '%')",
          [filters.key, filters.key],
        );
        res.send(
          resultData({
            items: result,
            total: totalRes[0]['COUNT(*)'],
          }),
        );
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误: ' + err.message));
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常：' + e.message));
  }
};

// 用户操作日志
export const recordOperationLogs = (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const log = {
      createBy: userId,
      ...req.body,
      del_flag: 0,
    };
    pool
      .query('INSERT INTO operation_logs SET ?', [snakeCaseKeys(log)])
      .then(() => {
        res.send(resultData(null));
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误: ' + err.message));
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常：' + e.message));
  }
};

export const getOperationLogs = (req, res) => {
  try {
    const { filters, pageSize, currentPage } = req.body;
    const skip = pageSize * (currentPage - 1);
    // 查询总数据条数
    pool
      .query(
        `SELECT o.*, u.alias,u.email
FROM operation_logs o
LEFT JOIN user u ON o.create_by = u.id
WHERE (u.alias LIKE CONCAT('%', ?, '%') 
OR o.operation LIKE CONCAT('%', ?, '%') 
OR o.module LIKE CONCAT('%', ?, '%')) 
AND o.del_flag = 0 AND u.alias!='菠萝'
ORDER BY o.create_time DESC
LIMIT ? OFFSET ?;
`,
        [filters.key, filters.key, filters.key, pageSize, skip],
      )
      .then(async ([result]) => {
        const totalSql = `SELECT COUNT(*) FROM operation_logs o left join user u on o.create_by=u.id WHERE 
(u.alias LIKE CONCAT('%', ?, '%') 
OR o.operation LIKE CONCAT('%', ?, '%') 
OR o.module LIKE CONCAT('%', ?, '%'))
AND o.del_flag=0 AND u.alias!='菠萝'`;
        const [totalRes] = await pool.query(totalSql, [filters.key, filters.key, filters.key]);
        res.send(
          resultData({
            items: result,
            total: totalRes[0]['COUNT(*)'],
          }),
        );
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误: ' + err.message));
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常：' + e.message));
  }
};

export const clearOperationLogs = (req, res) => {
  pool
    .query('UPDATE operation_logs set del_flag=1')
    .then(() => {
      res.send(resultData(null));
    })
    .catch((err) => {
      res.send(resultData(null, 500, '服务器内部错误: ' + err.message));
    });
};

// 定义支持的图片类型及其对应的扩展名
const imageMimeTypes = {
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
};

// 默认图片路径（可选）
const defaultImagePath = '/uploads/default-icon.png';

export const analyzeImgUrl = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const promises = req.body.map(async (bookmark) => {
      if (bookmark.noCache) {
        return new Promise((resolve, reject) => {
          const fileBuffer = [];
          const options = {
            hostname: 'icon.bqb.cool',
            path: '/?url=' + encodeURIComponent(bookmark.url),
            method: 'GET',
            rejectUnauthorized: false,
          };
          https
            .get(options, (response) => {
              const contentType = response.headers['content-type'];
              response.on('data', (chunk) => {
                fileBuffer.push(chunk);
              });
              response.on('end', async () => {
                try {
                  const buffer = Buffer.concat(fileBuffer);
                  // 确定文件扩展名
                  let fileExtension = 'png';
                  const mimeType = Object.entries(imageMimeTypes).find(([key, value]) =>
                    contentType.includes(key),
                  )?.[1];
                  if (mimeType) {
                    fileExtension = mimeType;
                  }

                  const fileName = `bookmark-${bookmark.id}.${fileExtension}`;
                  const uploadDir = '/www/wwwroot/images';

                  // 确保目录存在
                  await fsP.mkdir(uploadDir, { recursive: true });

                  // 写入文件
                  const imagePath = path.join(uploadDir, fileName);
                  await fsP.writeFile(imagePath, buffer);

                  // 生成URL
                  const imageUrl = `https://${req.get('host')}/uploads/${fileName}`;

                  // 更新数据库中的 icon_url 字段为生成的URL
                  const insertIconUrlSql = `UPDATE bookmark SET icon_url=? WHERE id=?`;
                  await connection.query(insertIconUrlSql, [imageUrl, bookmark.id]);

                  // 返回图片的 URL
                  resolve(imageUrl);
                } catch (err) {
                  console.error('处理过程中出错:', err);
                  // 返回默认图片的 URL
                  resolve(`${req.protocol}://${req.get('host')}${defaultImagePath}`);
                }
              });
            })
            .on('error', (err) => {
              console.error('Error downloading file:', err);
              // 返回默认图片的 URL
              reject(`${req.protocol}://${req.get('host')}${defaultImagePath}`);
            });
        });
      }
    });

    const results = await Promise.all(promises);
    res.send(resultData(results, 200, '所有图标已更新成功'));
  } catch (err) {
    res.send(resultData(null, 500, '服务器内部错误: ' + err.message));
  } finally {
    connection.release();
  }
};

export const getImages = async (req, res) => {
  const [bookmarkResult] = await pool.query('select icon_url from bookmark');
  const [noteResult] = await pool.query('select url from note_images');
  // 指定要读取的目录路径
  const directoryPath = '/www/wwwroot/images';

  try {
    // 读取目录中的所有文件和子目录
    const files = fs.readdirSync(directoryPath);

    // 过滤并处理文件名和后缀
    let fileList = files.map((file) => {
      const ext = path.extname(file); // 获取文件后缀
      const fileName = path.basename(file, ext); // 获取文件名（不带后缀）
      return {
        name: fileName,
        extension: ext.split('.')[1],
        fullFileName: file, // 如果需要完整的文件名（包括后缀）
      };
    });

    const bookmarkImages = bookmarkResult.map((bookmark) => bookmark.icon_url);
    const noteImages = noteResult.map((note) => note.url);
    const images = bookmarkImages.concat(noteImages);
    if (req.body.name) {
      fileList = fileList.filter((file) => {
        return file.name.includes(req.body.name);
      });
    }
    res.send(
      resultData({
        items: {
          images: images,
          usedImages: fileList.filter((file) => {
            return images.some((data) => {
              if (typeof data === 'string') {
                return data.includes(file.name);
              }
              return false;
            });
          }),
          unUsedImages: fileList.filter((file) => {
            return !images.some((data) => {
              if (typeof data === 'string') {
                return data.includes(file.name);
              }
              return false;
            });
          }),
        },
        total: fileList.length,
      }),
    );
  } catch (error) {
    console.error('读取目录时出错：', error);
  }
};

export const clearImages = async (req, res) => {
  const directoryPath = '/www/wwwroot/images';
  const images = req.body.images;

  // 定义删除文件的函数
  const deleteFile = async (filePath) => {
    try {
      await fsP.unlink(filePath);
      console.log(`文件删除成功: ${filePath}`);
    } catch (error) {
      console.error(`删除文件失败: ${filePath}`, error);
      throw error; // 抛出错误以便Promise.all捕获
    }
  };

  // 构造所有需要删除的文件路径
  const deletePromises = images.map(async (data) => {
    const filePath = path.join(directoryPath, data.fullFileName);
    return deleteFile(filePath);
  });

  try {
    // 等待所有删除操作完成
    await Promise.all(deletePromises);
    res.send(resultData(req.body, 200, '删除成功'));
  } catch (error) {
    // 如果有任何删除操作失败，返回错误响应
    console.error('删除过程中出现错误:', error);
    res.status(500).send(resultData(req.body, 500, '删除失败'));
  }
};

export const runSql = async (req, res) => {
  try {
    const [result] = await pool.query(req.body.sql);
    res.send(resultData(result, 200));
  } catch (e) {
    res.send(resultData(e.message, 200));
  }
};

export const getHelpConfig = async (req, res) => {
  try {
    await ensureHelpSortReady();
    const [result] = await pool.query('SELECT id,title,content,sort FROM help_config ORDER BY sort ASC, id ASC');
    res.send(resultData(result, 200));
  } catch (e) {
    res.send(resultData(e.message, 200));
  }
};

export const updateHelp = async (req, res) => {
  try {
    const userId = await ensureRootRole(req, res);
    if (!userId) return;
    const { id, content } = req.body;
    const [result] = await pool.query('UPDATE help_config SET content=? WHERE id=?', [content, id]);
    res.send(resultData(result, 200));
  } catch (e) {
    res.send(resultData(e.message, 200));
  }
};

export const getHelpDraftConfig = async (req, res) => {
  try {
    const userId = await ensureRootRole(req, res);
    if (!userId) return;
    await ensureHelpSortReady();
    const [draftResult] = await pool.query(
      'SELECT id,title,content,sort FROM help_config_draft ORDER BY sort ASC, id ASC',
    );
    if (draftResult.length > 0) {
      res.send(resultData(draftResult, 200));
      return;
    }
    const [publishedResult] = await pool.query('SELECT id,title,content,sort FROM help_config ORDER BY sort ASC, id ASC');
    res.send(resultData(publishedResult, 200));
  } catch (e) {
    res.send(resultData(e.message, 200));
  }
};

export const saveHelpDraft = async (req, res) => {
  try {
    const userId = await ensureRootRole(req, res);
    if (!userId) return;
    await ensureHelpSortReady();
    const { id, title, content } = req.body || {};
    if (typeof title !== 'string' || typeof content !== 'string') {
      res.send(resultData(null, 400, '缺少必要参数'));
      return;
    }

    const normalizedTitle = String(title || '').trim();
    if (!normalizedTitle) {
      res.send(resultData(null, 400, '标题不能为空'));
      return;
    }

    if (id === undefined || id === null || id === '') {
      // 新增模式按标题去重，避免重复点击产生同名重复草稿。
      const [existingRows] = await pool.query(
        'SELECT id,sort FROM help_config_draft WHERE title=? ORDER BY sort ASC, id ASC LIMIT 1',
        [normalizedTitle],
      );
      if (existingRows.length > 0) {
        const targetId = existingRows[0].id;
        await pool.query('UPDATE help_config_draft SET title=?,content=?,updated_by=? WHERE id=?', [
          normalizedTitle,
          content,
          userId,
          targetId,
        ]);
        const [rowResult] = await pool.query('SELECT id,title,content,sort FROM help_config_draft WHERE id=? LIMIT 1', [
          targetId,
        ]);
        res.send(resultData(rowResult[0] || { id: targetId, title: normalizedTitle, content, sort: existingRows[0].sort }, 200));
        return;
      }

      const [maxSortRows] = await pool.query('SELECT COALESCE(MAX(sort), -1) AS maxSort FROM help_config_draft');
      const nextSort = Number(maxSortRows?.[0]?.maxSort ?? -1) + 1;
      const [insertResult] = await pool.query(
        'INSERT INTO help_config_draft (title,content,updated_by,sort) VALUES (?,?,?,?)',
        [normalizedTitle, content, userId, nextSort],
      );
      const insertedId = insertResult.insertId;
      if (insertedId) {
        const [rowResult] = await pool.query('SELECT id,title,content,sort FROM help_config_draft WHERE id=? LIMIT 1', [
          insertedId,
        ]);
        res.send(resultData(rowResult[0] || { id: insertedId, title: normalizedTitle, content, sort: nextSort }, 200));
        return;
      }

      res.send(resultData({ id: '', title: normalizedTitle, content, sort: nextSort }, 200));
      return;
    }

    const [updateResult] = await pool.query('UPDATE help_config_draft SET title=?,content=?,updated_by=? WHERE id=?', [
      normalizedTitle,
      content,
      userId,
      id,
    ]);
    if (!updateResult.affectedRows) {
      const [maxSortRows] = await pool.query('SELECT COALESCE(MAX(sort), -1) AS maxSort FROM help_config_draft');
      const nextSort = Number(maxSortRows?.[0]?.maxSort ?? -1) + 1;
      await pool.query('INSERT INTO help_config_draft (id,title,content,updated_by,sort) VALUES (?,?,?,?,?)', [
        id,
        normalizedTitle,
        content,
        userId,
        nextSort,
      ]);
    }
    const [rowResult] = await pool.query('SELECT id,title,content,sort FROM help_config_draft WHERE id=? LIMIT 1', [id]);
    res.send(resultData(rowResult[0] || { id, title: normalizedTitle, content }, 200));
  } catch (e) {
    res.send(resultData(e.message, 200));
  }
};

export const saveHelpDraftBatch = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const userId = await ensureRootRole(req, res);
    if (!userId) return;
    await ensureHelpSortReady();
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      res.send(resultData(null, 400, '缺少草稿数据'));
      return;
    }
    await connection.beginTransaction();
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (typeof item?.title !== 'string' || typeof item?.content !== 'string') {
        continue;
      }
      const normalizedTitle = String(item.title || '').trim();
      if (!normalizedTitle) {
        continue;
      }
      const normalizedSort = Number.isFinite(Number(item?.sort)) ? Number(item.sort) : index;
      if (item?.id === undefined || item?.id === null || item?.id === '') {
        await connection.query('INSERT INTO help_config_draft (title,content,updated_by,sort) VALUES (?,?,?,?)', [
          normalizedTitle,
          item.content,
          userId,
          normalizedSort,
        ]);
      } else {
        const [updateResult] = await connection.query(
          'UPDATE help_config_draft SET title=?,content=?,updated_by=?,sort=? WHERE id=?',
          [normalizedTitle, item.content, userId, normalizedSort, item.id],
        );
        if (updateResult.affectedRows === 0) {
          await connection.query('INSERT INTO help_config_draft (id,title,content,updated_by,sort) VALUES (?,?,?,?,?)', [
            item.id,
            normalizedTitle,
            item.content,
            userId,
            normalizedSort,
          ]);
        }
      }
    }
    await connection.commit();
    res.send(resultData(null, 200, '草稿保存成功'));
  } catch (e) {
    await connection.rollback();
    res.send(resultData(e.message, 200));
  } finally {
    connection.release();
  }
};

export const syncHelpDraftFromPublished = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const userId = await ensureRootRole(req, res);
    if (!userId) return;
    await ensureHelpSortReady();
    await connection.beginTransaction();
    await connection.query('DELETE FROM help_config_draft');
    const [insertResult] = await connection.query(
      `INSERT INTO help_config_draft (id,title,content,updated_by,sort)
       SELECT id,title,content,?,sort FROM help_config ORDER BY sort ASC, id ASC`,
      [userId],
    );
    await connection.commit();
    res.send(resultData(insertResult, 200, '同步成功'));
  } catch (e) {
    await connection.rollback();
    res.send(resultData(e.message, 200));
  } finally {
    connection.release();
  }
};

export const publishHelpDraft = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const userId = await ensureRootRole(req, res);
    if (!userId) return;
    await ensureHelpSortReady();
    const { id } = req.body;
    if (!id) {
      res.send(resultData(null, 400, '缺少帮助项ID'));
      return;
    }
    await connection.beginTransaction();
    const [draftResult] = await connection.query('SELECT id,title,content,sort FROM help_config_draft WHERE id=? LIMIT 1', [
      id,
    ]);
    if (draftResult.length === 0) {
      await connection.rollback();
      res.send(resultData(null, 400, '未找到对应草稿'));
      return;
    }
    const target = draftResult[0];
    const title = String(target.title || '').trim();
    if (!title) {
      await connection.rollback();
      res.send(resultData(null, 400, '草稿标题为空，无法发布'));
      return;
    }
    const [existRows] = await connection.query('SELECT id FROM help_config WHERE title=? ORDER BY sort ASC, id ASC LIMIT 1', [
      title,
    ]);
    if (existRows.length > 0) {
      await connection.query('UPDATE help_config SET title=?,content=?,sort=? WHERE id=?', [
        title,
        target.content,
        target.sort,
        existRows[0].id,
      ]);
    } else {
      await connection.query('INSERT INTO help_config (title,content,sort) VALUES (?,?,?)', [title, target.content, target.sort]);
    }
    await connection.commit();
    res.send(resultData(null, 200, '发布成功'));
  } catch (e) {
    await connection.rollback();
    res.send(resultData(e.message, 200));
  } finally {
    connection.release();
  }
};

export const publishAllHelpDraft = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const userId = await ensureRootRole(req, res);
    if (!userId) return;
    await ensureHelpSortReady();
    await connection.beginTransaction();
    const [draftResult] = await connection.query('SELECT id,title,content,sort FROM help_config_draft ORDER BY sort ASC, id ASC');

    // 全量替换：先清空帮助中心，再按草稿重建。
    await connection.query('DELETE FROM help_config');
    let insertedTotal = 0;
    for (const row of draftResult) {
      const title = String(row.title || '').trim();
      if (!title) continue;
      await connection.query('INSERT INTO help_config (id,title,content,sort) VALUES (?,?,?,?)', [
        row.id,
        title,
        row.content,
        row.sort,
      ]);
      insertedTotal++;
    }
    await connection.commit();
    res.send(resultData({ total: insertedTotal }, 200, '帮助中心已按草稿全量替换'));
  } catch (e) {
    await connection.rollback();
    res.send(resultData(e.message, 200));
  } finally {
    connection.release();
  }
};

export const deleteHelpDraft = async (req, res) => {
  try {
    const userId = await ensureRootRole(req, res);
    if (!userId) return;
    const { id } = req.body || {};
    if (id === undefined || id === null || id === '') {
      res.send(resultData(null, 400, '缺少草稿ID'));
      return;
    }
    const [deleteResult] = await pool.query('DELETE FROM help_config_draft WHERE id=?', [id]);
    if (!deleteResult.affectedRows) {
      res.send(resultData(null, 404, '草稿不存在'));
      return;
    }
    res.send(resultData(null, 200, '删除草稿成功'));
  } catch (e) {
    res.send(resultData(e.message, 200));
  }
};
