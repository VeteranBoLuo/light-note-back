import express from 'express';
const router = express.Router();

import * as userHandle from '../router_handle/userHandle.js';

router.post('/login', userHandle.login);

router.get('/getUserInfo', userHandle.getUserInfo);

router.post('/getUserList', userHandle.getUserList);

router.post('/registerUser', userHandle.registerUser);

router.post('/saveUserInfo', userHandle.saveUserInfo);

router.get('/deleteUserById', userHandle.deleteUserById);

router.post('/github', userHandle.github);

router.post('/configPassword', userHandle.configPassword);

router.post('/sendEmail', userHandle.sendEmail);

router.post('/verifyCode', userHandle.verifyCode);

export default router;
