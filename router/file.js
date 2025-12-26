import express from 'express';
import { resultData, snakeCaseKeys } from '../util/common.js';
import pool from '../db/index.js';
import {
  bucketBaseUrl,
  buildObjectKey,
  buildObjectUrl,
  createDownloadSignedUrl,
  createUploadSignedUrl,
  deleteObjectFromObs,
} from '../util/obsClient.js';
import * as fileHandle from '../router_handle/fileHandle.js';
const router = express.Router();

const buildSignedDownloadUrl = (objectKey, expires = 600) => {
  if (!objectKey) return null;
  const { url } = createDownloadSignedUrl({ objectKey, expires });
  return url || buildObjectUrl(objectKey);
};

router.post('/uploadFiles', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { files } = req.body || {};

    if (!userId) {
      return res.send(resultData(null, 400, '缺少用户信息'));
    }

    if (!Array.isArray(files) || files.length === 0) {
      return res.send(resultData(null, 400, '没有上传文件'));
    }

    const results = files.map((file) => {
      const fileName = file.fileName || file.filename;
      const fileType = file.fileType || file.mimetype || 'application/octet-stream';

      if (!fileName) {
        return { filename: '', status: '处理失败', error: '缺少文件名' };
      }

      const objectKey = buildObjectKey(userId, fileName);
      const { url, headers, expiresIn } = createUploadSignedUrl({
        objectKey,
        contentType: fileType,
      });

      return {
        filename: fileName,
        fileType,
        objectKey,
        uploadUrl: url,
        headers,
        expiresIn,
      };
    });

    res.send(resultData(results));
  } catch (e) {
    res.send(resultData(null, 500, '服务器内部错误: ' + e.message));
  }
});

// 前端直传 OBS 成功后回调此接口，将文件信息写入数据库
router.post('/confirmUpload', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const userId = req.headers['x-user-id'];
    const { files } = req.body || {};

    if (!userId) {
      connection.release();
      return res.send(resultData(null, 400, '缺少用户信息'));
    }

    if (!Array.isArray(files) || files.length === 0) {
      connection.release();
      return res.send(resultData(null, 400, '没有上传文件'));
    }

    await connection.beginTransaction();
    const results = [];

    for (const file of files) {
      const fileName = file.fileName;
      const fileType = file.fileType || 'application/octet-stream';
      const fileSize = file.fileSize || 0;

      if (!fileName) {
        results.push({ filename: '', status: '处理失败', error: '缺少文件名' });
        continue;
      }

      const objectKey = buildObjectKey(userId, fileName);
      const directory = `${bucketBaseUrl}/${userId}/`;

      const fileInfo = {
        create_by: userId,
        create_time: req.requestTime,
        file_name: fileName,
        file_type: fileType,
        file_size: fileSize,
        directory,
        obs_key: objectKey,
      };

      const selectSql = 'SELECT * FROM files WHERE create_by = ? AND file_name = ?';
      const [existingRows] = await connection.query(selectSql, [userId, fileName]);

      if (existingRows.length > 0) {
        const deleteSql = 'DELETE FROM files WHERE id = ?';
        await connection.query(deleteSql, [existingRows[0].id]);
      }

      const insertSql = 'INSERT INTO files SET ?';
      const [insertResult] = await connection.query(insertSql, [snakeCaseKeys(fileInfo)]);

      results.push({
        filename: fileName,
        status: existingRows.length > 0 ? '已覆盖' : '已上传',
        fileId: insertResult.insertId,
      });
    }

    await connection.commit();
    res.send(resultData(results));
  } catch (error) {
    await connection.rollback();
    res.send(resultData(null, 500, '服务器内部错误: ' + error.message));
  } finally {
    connection.release();
  }
});

// 查询所有文件
router.post('/queryFiles', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { filters = {} } = req.body;
    const params = [userId];
    // 1. 查询所有该用户创建的文件，并关联文件夹名称
    let sql =
      'SELECT files.*, folders.name AS folderName FROM files LEFT JOIN folders ON files.folder_id = folders.id WHERE files.create_by = ?';
    // 添加文件夹ID条件
    if (filters.folderId !== 'all') {
      sql += ' AND files.folder_id = ?';
      params.push(filters.folderId);
    }
    sql += ' AND files.del_Flag=0 ORDER BY files.create_time DESC';
    const [files] = await pool.query(sql, params);

    // 2. 格式化结果
    let formattedFiles = files.map((file) => ({
      id: file.id,
      fileName: file.file_name,
      fileType: file.file_type,
      fileSize: file.file_size,
      fileUrl: file.obs_key ? buildSignedDownloadUrl(file.obs_key) : file.directory + file.file_name,
      uploadTime: file.create_time,
      folderId: file.folder_id,
      folderName: file.folderName, // 添加文件夹名称
      obs_key: file.obs_key,
    }));

    // 3. 应用文件名过滤
    if (filters?.fileName) {
      formattedFiles = formattedFiles.filter((file) => file.fileName.includes(filters.fileName));
    }

    // 4. 应用文件类型过滤
    const typeFilters = filters?.type || [];
    if (typeFilters.length > 0) {
      // 定义文件类型到 MIME 类型的映射
      const mimeTypeMap = {
        image: ['image/jpeg', 'image/png', 'image/gif', 'image/svg+xml'],
        pdf: ['application/pdf'],
        word: ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        audio: ['audio/mpeg', 'audio/wav'],
        video: ['video/mp4', 'video/quicktime'],
        excel: ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      };

      // 提取用户选择的类型
      const selectedNonOtherTypes = typeFilters.filter((t) => t !== 'other');
      const hasOther = typeFilters.includes('other');

      // 构建需要包含的 MIME 类型（非 other 类型）
      const includeMimeTypes = selectedNonOtherTypes.flatMap((type) => mimeTypeMap[type] || []);

      // 构建需要排除的 MIME 类型（用于 other 逻辑）
      const excludeMimeTypes = ['image', 'pdf', 'word', 'excel', 'audio', 'video'].flatMap((type) => mimeTypeMap[type]);

      // 过滤文件
      formattedFiles = formattedFiles.filter((file) => {
        const matchesSelected = includeMimeTypes.includes(file.fileType);
        const matchesOther = hasOther && !excludeMimeTypes.includes(file.fileType);
        return matchesSelected || matchesOther;
      });
    }
    if ((filters?.type || []).length === 0) {
      res.send(resultData([]));
    } else {
      res.send(resultData(formattedFiles));
    }
  } catch (error) {
    console.error('查询文件时出错:', error);
    res.send(resultData(null, 500, '服务器内部错误: ' + error.message));
  }
});

// 后端：/downloadFileById 接口
router.post('/downloadFileById', async (req, res) => {
  try {
    const { id } = req.body;

    // 查询文件信息
    const sql = 'SELECT * FROM files WHERE id = ?';
    const [results] = await pool.query(sql, [id]);

    if (results.length === 0) {
      return res.send(resultData(null, 404, '文件未找到'));
    }

    const file = results[0];
    const objectKey = file.obs_key || buildObjectKey(file.create_by, file.file_name);
    const { url, expiresIn } = createDownloadSignedUrl({ objectKey, expires: 600 });

    if (!url) {
      return res.send(resultData(null, 500, '获取下载链接失败'));
    }

    res.send(
      resultData({
        downloadUrl: url,
        fileName: file.file_name,
        fileType: file.file_type,
        fileSize: file.file_size,
        expiresIn,
      }),
    );
  } catch (error) {
    console.error('下载文件时出错:', error);
    res.send(resultData(null, 500, '服务器内部错误')); // 设置状态码为500
  }
});

// 根据id删除文件，同时删除服务器上数据
router.post('/deleteFileById', async (req, res) => {
  try {
    const { id } = req.body;

    // 查询文件信息
    const sql = 'SELECT * FROM files WHERE id = ?';
    const [results] = await pool.query(sql, [id]);

    if (results.length === 0) {
      return res.send(resultData(null, 404, '文件未找到'));
    }

    const file = results[0];
    const objectKey = file.obs_key || buildObjectKey(file.create_by, file.file_name);

    try {
      await deleteObjectFromObs(objectKey);
    } catch (deleteError) {
      console.error(`删除 OBS 对象失败 ${objectKey}: ${deleteError.message}`);
      return res.send(resultData(null, 500, '删除文件失败: ' + deleteError.message));
    }

    const deleteSql = 'DELETE FROM files WHERE id = ?';
    await pool.query(deleteSql, [id]);
    res.send(resultData({ id }));
  } catch (e) {
    console.error('删除文件时出错:', e);
    res.send(resultData(null, 500, '服务器内部错误: ' + e.message));
  }
});

// 查询某个人下的文件的总共大小（单位MB）
router.post('/queryTotalFileSize', async (req, res) => {
  try {
    // 获取用户ID
    const userId = req.headers['x-user-id'];

    // 构建SQL查询
    const sql = 'SELECT SUM(file_size) as total_size FROM files WHERE create_by = ?';
    const [result] = await pool.query(sql, [userId]);
    console.log(result[0].total_size / 1024);
    // 提取总大小（MB）保留两位小数
    const totalSizeMB = parseFloat((result[0].total_size / (1024 * 1024)).toFixed(2));
    // 返回结果
    res.send(resultData({ totalSizeMB }));
  } catch (error) {
    // 处理错误
    console.error('查询文件总大小时出错:', error);
    res.send(resultData(null, 500, '服务器内部错误: ' + error.message));
  }
});

router.post('/updateFile', fileHandle.updateFile);

router.post('/queryFolder', fileHandle.queryFolder);
router.post('/addFolder', fileHandle.addFolder);
router.post('/associateFile', fileHandle.associateFile);
router.post('/updateFolder', fileHandle.updateFolder);
router.post('/deleteFolder', fileHandle.deleteFolder);
router.post('/updateFolderSort', fileHandle.updateFolderSort);
export default router;
