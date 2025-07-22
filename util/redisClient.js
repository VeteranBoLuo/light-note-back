// redisClient.js

const { createClient } = require('redis');

const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});

redisClient.on('error', (err) => console.error('Redis连接错误:', err));

redisClient.connect().then(() => {
  console.log('Redis连接成功');
});

module.exports = redisClient;