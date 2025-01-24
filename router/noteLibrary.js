const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const noteLibraryHandle = require('../router_handle/noteLibraryHandle');

// 配置multer存储
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, '/www/wwwroot/images'); // 确保这个目录存在
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({ storage: storage });
const { resultData } = require('../util/common');

router.post('/uploadFile', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.send(resultData(null, 400, '没有上传文件'));
    }
    // 构建文件的URL
    const fileUrl = req.protocol + '://' + req.get('host') + '/uploads/' + req.file.filename;

    // 返回文件的URL
    res.send(resultData({ url: fileUrl }));
  } catch (e) {
    res.send(resultData(null, 500, '服务器内部错误' + e));
  }
});

router.post('/updateNote', noteLibraryHandle.updateNote);
router.post('/addNote', noteLibraryHandle.addNote);
router.post('/queryNoteList', noteLibraryHandle.queryNoteList);
router.post('/getNoteDetail', noteLibraryHandle.getNoteDetail);

module.exports = router;
