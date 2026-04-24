import express from 'express';
import * as searchHandle from '../router_handle/searchHandle.js';

const router = express.Router();

router.post('/global', searchHandle.globalSearch);

export default router;
