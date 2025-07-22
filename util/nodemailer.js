import nodemailer from 'nodemailer';

let nodeMail = nodemailer.createTransport({
  service: 'qq', //类型qq邮箱
  port: 465,
  secure: true, //上文获取的secure
  auth: {
    user: '1902013368@qq.com', // 发送方的邮箱，可以选择你自己的qq邮箱
    pass: 'vqmyhzpyuxujefgf', // stmp授权码
  },
});

export default nodeMail;