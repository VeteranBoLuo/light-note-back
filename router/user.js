const express = require("express");
const router = express.Router();

const userHandle= require('../router_handle/userHandle');

router.post('/login', userHandle.login);

router.get('/getUserInfo', userHandle.getUserInfo);

router.post('/getUserList', userHandle.getUserList);

router.post('/registerUser',userHandle.registerUser)

router.post('/saveUserInfo',userHandle.saveUserInfo)

router.get('/deleteUserById',userHandle.deleteUserById)

router.post('/github',userHandle.github)

router.post('/configPassword',userHandle.configPassword)


module.exports = router