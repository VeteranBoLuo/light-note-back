import { createClient } from 'redis';

const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
});

redisClient.on('error', (err) => console.error('Redis连接错误:', err));

redisClient.connect().then(() => {
  console.log('Redis连接成功');
});

export default redisClient;