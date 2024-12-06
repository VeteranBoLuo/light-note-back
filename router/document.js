
const express = require("express");
const router = express.Router();

const documentHandle= require('../router_handle/documentHandle');

router.post('/saveDocument', documentHandle.saveDocument);
router.post('/queryDocumentList', documentHandle.queryDocumentList);

router.post('/getDocumentDetail', documentHandle.getDocumentDetail);
router.post('/delDocument', documentHandle.delDocument);




module.exports = router