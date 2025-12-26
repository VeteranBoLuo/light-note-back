import multer from 'multer';
import { resultData, snakeCaseKeys } from '../util/common.js';
import pool from '../db/index.js';
import express from 'express';
import * as fileHandle from '../router_handle/fileHandle.js';
import ObsClient from 'esdk-obs-nodejs';

const router = express.Router();

const OBS_AK = 'HPUAVAKVYRUUYKOIUUYZ';
const OBS_SK = 'Kax2vXaUmYbMXyMxFqEk7LDjVCnJQHSOL1wOLVrQ';
const OBS_ENDPOINT = 'https://obs.cn-south-1.myhuaweicloud.com';
const OBS_BUCKET_NAME = 'light-note-files';

// 初始化OBS客户端
const obsClient = new ObsClient({
  access_key_id: OBS_AK,
  secret_access_key: OBS_SK,
  server: OBS_ENDPOINT,
});

// 配置multer使用内存存储
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  cb(null, true);
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
});

// 上传接口 - 修改为上传到OBS
router.post('/uploadFiles', upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.send(resultData(null, 400, '没有上传文件'));
    }

    const files = req.files;
    const userId = req.headers['x-user-id'];
    const results = [];

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      for (const file of files) {
        try {
          // 保持原有文件名处理逻辑
          const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf-8');
          const { mimetype, size, buffer } = file;

          // 构建OBS对象键：使用用户ID和原始文件名保持唯一性
          const objectKey = `files/${userId}/${Date.now()}_${decodedName.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;

          // 构建文件访问URL（OBS地址）
          const directory = `${OBS_ENDPOINT}/${OBS_BUCKET_NAME}/`;

          // 准备文件信息
          const fileInfo = {
            create_by: userId,
            create_time: new Date(),
            file_name: decodedName, // 保持原始文件名
            file_type: mimetype,
            file_size: size,
            directory: directory,
            obs_key: objectKey, // 存储OBS对象键
          };

          // 检查是否已存在同名文件（保持原有逻辑）
          const selectSql = 'SELECT * FROM files WHERE create_by = ? AND file_name = ?';
          const [existingRows] = await connection.query(selectSql, [userId, decodedName]);

          if (existingRows.length > 0) {
            // 覆盖已存在文件
            const oldFile = existingRows[0];

            // 1. 删除OBS中的旧文件
            if (oldFile.obs_key) {
              try {
                await obsClient.deleteObject({
                  Bucket: OBS_BUCKET_NAME,
                  Key: oldFile.obs_key,
                });
                console.log(`OBS旧文件 ${oldFile.obs_key} 已删除`);
              } catch (deleteError) {
                console.error(`删除OBS旧文件失败:`, deleteError);
              }
            }

            // 2. 上传新文件到OBS
            await obsClient.putObject({
              Bucket: OBS_BUCKET_NAME,
              Key: objectKey,
              Body: buffer,
              ContentType: mimetype,
            });

            // 3. 更新数据库记录
            const updateSql = 'UPDATE files SET file_type = ?, file_size = ?, obs_key = ?, directory = ? WHERE id = ?';
            await connection.query(updateSql, [mimetype, size, objectKey, directory, oldFile.id]);

            results.push({
              filename: decodedName,
              status: '已覆盖',
              fileId: oldFile.id,
            });
          } else {
            // 上传新文件到OBS
            await obsClient.putObject({
              Bucket: OBS_BUCKET_NAME,
              Key: objectKey,
              Body: buffer,
              ContentType: mimetype,
            });

            // 插入新文件记录
            const insertSql = 'INSERT INTO files SET ?';
            const [insertResult] = await connection.query(insertSql, [snakeCaseKeys(fileInfo)]);

            results.push({
              filename: decodedName,
              status: '已上传',
              fileId: insertResult.insertId,
            });
          }
        } catch (fileError) {
          console.error(`处理文件 ${file.originalname} 时出错:`, fileError);
          results.push({
            filename: file.originalname,
            status: '处理失败',
            error: fileError.message,
          });
        }
      }

      await connection.commit();
      res.send(resultData(results));
    } catch (error) {
      await connection.rollback();
      console.error('上传事务失败:', error);
      res.send(resultData(null, 500, '服务器内部错误: ' + error.message));
    } finally {
      connection.release();
    }
  } catch (e) {
    console.error('上传过程异常:', e);
    res.send(resultData(null, 500, '服务器内部错误: ' + e.message));
  }
});

// 下载接口 - 修正版本
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

    if (!file.obs_key) {
      return res.send(resultData(null, 404, '文件对象标识缺失'));
    }

    // 从OBS获取文件流 - 添加 SaveAsStream: true 参数
    const obsResponse = await obsClient.getObject({
      Bucket: OBS_BUCKET_NAME,
      Key: file.obs_key,
      SaveAsStream: true  // 关键参数：确保返回流对象
    });

    if (obsResponse.CommonMsg.Status < 300) {
      // 设置响应头
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.file_name)}"`);
      res.setHeader('Content-Type', file.file_type || 'application/octet-stream');
      res.setHeader('Content-Length', file.file_size);
      res.setHeader('X-File-Name', encodeURIComponent(file.file_name));
      res.setHeader('X-File-Size', file.file_size);
      res.setHeader('X-File-Type', file.file_type);

      // 修正：使用正确的流对象路径
      // 根据华为云OBS SDK文档，流对象可能在 Content 属性中
      if (obsResponse.InterfaceResult.Content && typeof obsResponse.InterfaceResult.Content.pipe === 'function') {
        // 将OBS文件流管道传输到响应
        obsResponse.InterfaceResult.Content.pipe(res);
      } else if (obsResponse.InterfaceResult.pipe) {
        // 如果 InterfaceResult 本身有 pipe 方法（某些SDK版本）
        obsResponse.InterfaceResult.pipe(res);
      } else {
        // 如果以上都不行，尝试直接使用 Body 属性
        console.log('obsResponse结构:', Object.keys(obsResponse.InterfaceResult));
        throw new Error('无法找到有效的文件流对象');
      }
    } else {
      throw new Error(`OBS错误: ${obsResponse.CommonMsg.Code}`);
    }
  } catch (error) {
    console.error('下载文件时出错:', error);
    res.send(resultData(null, 500, `服务器内部错误: ${error.message}`));
  }
});

// 查询文件接口 - 需要修改文件URL为OBS地址
router.post('/queryFiles', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { filters } = req.body;
    const params = [userId];

    let sql =
      'SELECT files.*, folders.name AS folderName FROM files LEFT JOIN folders ON files.folder_id = folders.id WHERE files.create_by = ?';
    if (filters.folderId !== 'all') {
      sql += ' AND files.folder_id = ?';
      params.push(filters.folderId);
    }
    sql += ' AND files.del_Flag=0 ORDER BY files.create_time DESC';
    const [files] = await pool.query(sql, params);

    // 格式化结果 - 修改fileUrl为OBS地址
    let formattedFiles = files.map((file) => ({
      id: file.id,
      fileName: file.file_name, // 保持原始文件名
      fileType: file.file_type,
      fileSize: file.file_size,
      // 使用OBS地址
      fileUrl: file.obs_key
        ? `${OBS_ENDPOINT}/${OBS_BUCKET_NAME}/${file.obs_key}`
        : file.directory + file.file_name,
      uploadTime: file.create_time,
      folderId: file.folder_id,
      folderName: file.folderName,
    }));

    // 应用文件名过滤
    if (filters?.fileName) {
      formattedFiles = formattedFiles.filter((file) => file.fileName.includes(filters.fileName));
    }

    // 应用文件类型过滤（保持原有逻辑）
    if (filters?.type && filters.type.length > 0) {
      const mimeTypeMap = {
        image: ['image/jpeg', 'image/png', 'image/gif', 'image/svg+xml'],
        pdf: ['application/pdf'],
        word: ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        audio: ['audio/mpeg', 'audio/wav'],
        video: ['video/mp4', 'video/quicktime'],
        excel: ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      };

      const selectedNonOtherTypes = filters.type.filter((t) => t !== 'other');
      const hasOther = filters.type.includes('other');
      const includeMimeTypes = selectedNonOtherTypes.flatMap((type) => mimeTypeMap[type] || []);
      const excludeMimeTypes = ['image', 'pdf', 'word', 'excel', 'audio', 'video'].flatMap((type) => mimeTypeMap[type]);

      formattedFiles = formattedFiles.filter((file) => {
        const matchesSelected = includeMimeTypes.includes(file.fileType);
        const matchesOther = hasOther && !excludeMimeTypes.includes(file.fileType);
        return matchesSelected || matchesOther;
      });
    }

    if (filters.type.length === 0) {
      res.send(resultData([]));
    } else {
      res.send(resultData(formattedFiles));
    }
  } catch (error) {
    console.error('查询文件时出错:', error);
    res.send(resultData(null, 500, '服务器内部错误: ' + error.message));
  }
});

// 删除接口 - 修改为删除OBS中的文件
router.post('/deleteFileById', async (req, res) => {
  try {
    const { id } = req.body;

    const sql = 'SELECT * FROM files WHERE id = ?';
    const [results] = await pool.query(sql, [id]);

    if (results.length === 0) {
      return res.send(resultData(null, 404, '文件未找到'));
    }

    const file = results[0];

    // 删除OBS中的文件
    if (file.obs_key) {
      try {
        await obsClient.deleteObject({
          Bucket: OBS_BUCKET_NAME,
          Key: file.obs_key,
        });
        console.log(`OBS文件 ${file.obs_key} 已删除`);
      } catch (obsError) {
        console.error(`删除OBS文件失败: ${obsError.message}`);
      }
    }

    // 删除数据库记录
    const deleteSql = 'DELETE FROM files WHERE id = ?';
    await pool.query(deleteSql, [id]);

    res.send(resultData({ id }));
  } catch (error) {
    console.error('删除文件时出错:', error);
    res.send(resultData(null, 500, '服务器内部错误: ' + error.message));
  }
});

// 其他接口保持不变
router.post('/queryTotalFileSize', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const sql = 'SELECT SUM(file_size) as total_size FROM files WHERE create_by = ?';
    const [result] = await pool.query(sql, [userId]);
    const totalSizeMB = parseFloat((result[0].total_size / (1024 * 1024)).toFixed(2));
    res.send(resultData({ totalSizeMB }));
  } catch (error) {
    console.error('查询文件总大小时出错:', error);
    res.send(resultData(null, 500, '服务器内部错误: ' + error.message));
  }
});

// 其他路由保持不变
router.post('/updateFile', fileHandle.updateFile);
router.post('/queryFolder', fileHandle.queryFolder);
router.post('/addFolder', fileHandle.addFolder);
router.post('/associateFile', fileHandle.associateFile);
router.post('/updateFolder', fileHandle.updateFolder);
router.post('/deleteFolder', fileHandle.deleteFolder);
router.post('/updateFolderSort', fileHandle.updateFolderSort);

export default router;
