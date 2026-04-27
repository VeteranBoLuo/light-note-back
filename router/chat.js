import express from 'express';
const router = express.Router();

import * as chatHandle from '../router_handle/chatHandle.js';

router.post('/receiveMessage', chatHandle.receiveMessage);
router.post('/generateBookmarkMeta', chatHandle.generateBookmarkMeta);
router.post('/generateBookmarkDescription', chatHandle.generateBookmarkDescription);
router.post('/generateTagIcon', chatHandle.generateTagIcon);

export default router;
