const express = require("express");
const router = express.Router();

const bookmarkHandle = require("../router_handle/bookmarkHandle");
const commonHandle = require('../router_handle/commonHandle');

router.post("/queryTagList", bookmarkHandle.queryTagList);

router.post("/updateTagSort", bookmarkHandle.updateTagSort);


router.post("/getTagDetail", bookmarkHandle.getTagDetail);

router.post("/getRelatedTag", bookmarkHandle.getRelatedTag);

router.post("/getBookmarkList", bookmarkHandle.getBookmarkList);

router.post("/addTag", bookmarkHandle.addTag);

router.post("/delTag", bookmarkHandle.delTag);

router.post("/updateTag", bookmarkHandle.updateTag);

router.post("/addBookmark", bookmarkHandle.addBookmark);

router.post("/getBookmarkDetail", bookmarkHandle.getBookmarkDetail);

router.post("/delBookmark", bookmarkHandle.delBookmark);

router.post("/updateBookmark", bookmarkHandle.updateBookmark);

router.post('/getCommonBookmarks', bookmarkHandle.getCommonBookmarks);


module.exports = router;
