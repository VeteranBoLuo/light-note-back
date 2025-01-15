const express = require("express");
const router = express.Router();

const opinionHandle = require('../router_handle/opinionHandle');
router.post("/recordOpinion", opinionHandle.recordOpinion);

router.post("/getOpinionList", opinionHandle.getOpinionList);

router.post("/delOpinion", opinionHandle.delOpinion);



module.exports = router;