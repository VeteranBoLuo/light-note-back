import express from 'express';
const router = express.Router();

import * as chatHandle from '../router_handle/chatHandle.js';

router.post('/receiveMessage', chatHandle.receiveMessage);
router.post('/generateBookmarkDescription', chatHandle.generateBookmarkDescription);

export default router;
