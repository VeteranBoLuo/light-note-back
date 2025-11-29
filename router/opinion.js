import express from "express";
const router = express.Router();

import * as opinionHandle from '../router_handle/opinionHandle.js';

router.post("/recordOpinion", opinionHandle.recordOpinion);

router.post("/getOpinionList", opinionHandle.getOpinionList);

router.post("/delOpinion", opinionHandle.delOpinion);



export default router;