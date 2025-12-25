import { resultData, snakeCaseKeys, requestTime } from '../util/common.js';
import https from 'https';
import fs from 'fs';
import fsP from 'fs/promises';
import path from 'path';
import pool from '../db/index.js';
import { validateQueryParams } from '../util/request.js';

export const getApiLogs = (req, res) => {
  try {
    const { filters, pageSize, currentPage } = validateQueryParams(req.body);
    const key = filters.key.trim();
    const skip = pageSize * (currentPage - 1);
    let sql = `SELECT a.*,u.alias,u.email 
      FROM api_logs a left join user u on a.user_id=u.id  where (u.alias LIKE CONCAT('%', ?, '%') 
      OR a.ip LIKE CONCAT('%', ?, '%')) AND a.del_flag=0  
      ORDER BY a.request_time DESC LIMIT ? OFFSET ?`;
    pool
      .query(sql, [filters.key, filters.key, pageSize, skip])
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
    const attackType = filters.attack_type ? filters.attack_type.trim() : '';
    const sourceIp = filters.source_ip ? filters.source_ip.trim() : '';
    const skip = pageSize * (currentPage - 1);
    let sql = `SELECT * FROM attack_logs WHERE attack_type LIKE CONCAT('%', ?, '%') AND source_ip LIKE CONCAT('%', ?, '%') ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    pool
      .query(sql, [attackType, sourceIp, pageSize, skip])
      .then(async ([result]) => {
        const [totalRes] = await pool.query(
          "SELECT COUNT(*) FROM attack_logs WHERE attack_type LIKE CONCAT('%', ?, '%') AND source_ip LIKE CONCAT('%', ?, '%')",
          [attackType, sourceIp],
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
      createTime: req.requestTime,
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
                  const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${fileName}`;

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
    const [result] = await pool.query('SELECT * FROM help_config');
    res.send(resultData(result, 200));
  } catch (e) {
    res.send(resultData(e.message, 200));
  }
};

export const updateHelp = async (req, res) => {
  try {
    const { id, content } = req.body;
    const [result] = await pool.query('UPDATE help_config SET content=? WHERE id=?', [content, id]);
    res.send(resultData(result, 200));
  } catch (e) {
    res.send(resultData(e.message, 200));
  }
};
