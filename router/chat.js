import express from 'express';
const router = express.Router();

import * as chatHandle from '../router_handle/chatHandle.js';

router.post('/receiveMessage', chatHandle.receiveMessage);

export default router;