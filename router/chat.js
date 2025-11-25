const express = require('express');
const router = express.Router();

const chatHandle = require('../router_handle/chatHandle');
router.post('/receiveMessage', chatHandle.receiveMessage);

module.exports = router;