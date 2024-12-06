const express = require("express");
const router = express.Router();

const commonHandle = require("../router_handle/commonHandle");
router.post("/getApiLogs", commonHandle.getApiLogs);

router.get("/clearApiLogs", commonHandle.clearApiLogs);

router.post("/addOperationLogs", commonHandle.addOperationLogs);

router.post("/getOperationLogs", commonHandle.getOperationLogs);

router.get("/clearOperationLogs", commonHandle.clearOperationLogs);

router.post("/analyzeImgUrl", commonHandle.analyzeImgUrl);

module.exports = router;
