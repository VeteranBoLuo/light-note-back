import nodemailer from 'nodemailer';

const nodeMail = nodemailer.createTransport({
  service: 'qq',
  port: 465,
  secure: true,
  auth: {
    user: '1902013368@qq.com',
    pass: 'vqmyhzpyuxujefgf',
  },
  logger: true,
});

export default nodeMail;
