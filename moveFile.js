// migrate_old_files.js
import ObsClient from 'esdk-obs-nodejs';
import pool from './db/index.js';
import fs from 'fs';
import path from 'path';
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
async function migrateOldFiles() {
  console.log('开始迁移老文件...');

  // 1. 查询所有没有obs_key的老文件记录
  const [oldFiles] = await pool.query('SELECT * FROM files WHERE obs_key IS NULL OR obs_key = ""');
  console.log(`找到 ${oldFiles.length} 个需要迁移的老文件`);

  for (const file of oldFiles) {
    const localFilePath = path.join('/www/wwwroot/files', file.file_name);

    // 检查本地文件是否存在
    if (!fs.existsSync(localFilePath)) {
      console.warn(`本地文件不存在，跳过: ${localFilePath}`);
      continue;
    }

    try {
      // 2. 在OBS中创建唯一的对象键
      // 使用和老逻辑类似的路径，例如: files/{user_id}/{timestamp}_original_name
      // 这里加上 `migrated_` 前缀以便区分
      const objectKey = `files/${file.create_by}/${file.file_name}`;

      // 3. 上传文件到OBS
      console.log(`正在上传: ${file.file_name} -> ${objectKey}`);
      await obsClient.putObject({
        Bucket: OBS_BUCKET_NAME,
        Key: objectKey,
        Body: fs.createReadStream(localFilePath),
        ContentType: file.file_type,
      });

      // 4. 更新数据库，设置obs_key和新的directory
      const newDirectory = `${OBS_ENDPOINT}/${OBS_BUCKET_NAME}/`;
      const updateSql = 'UPDATE files SET obs_key = ?, directory = ? WHERE id = ?';
      await pool.query(updateSql, [objectKey, newDirectory, file.id]);

      console.log(`✓ 成功迁移: ${file.file_name}`);

      // 5. (可选) 上传并验证成功后，删除本地文件以节省空间
      // fs.unlinkSync(localFilePath);
      // console.log(`已删除本地文件: ${localFilePath}`);
    } catch (error) {
      console.error(`迁移文件失败 ${file.file_name}:`, error);
      // 记录失败，但继续迁移其他文件
    }
  }
  console.log('老文件迁移完成！');
}

// 执行迁移
migrateOldFiles()
  .then(() => {
    console.log('所有操作完成。');
    process.exit(0);
  })
  .catch((err) => {
    console.error('迁移过程发生错误:', err);
    process.exit(1);
  });
