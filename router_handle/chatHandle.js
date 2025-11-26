const axios = require('axios');
const { resultData } = require('../util/common');
const { Transform } = require('stream');

// 创建自定义转换流优化数据处理
class SSETransform extends Transform {
  constructor() {
    super({ objectMode: true });
    this.buffer = '';
  }

  _transform(chunk, encoding, callback) {
    const chunkStr = chunk.toString();
    this.buffer += chunkStr;
    
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop(); // 保留未完成的行
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('data:')) {
        this.push(trimmedLine + '\n\n');
      }
    }
    
    callback();
  }
}

exports.receiveMessage = async (req, res) => {
  req.setTimeout(0);

  try {
    const { message, sessionId = '', stream = false } = req.body;
    const APP_ID = "01e9e79a38d9433aa0e9795154b06704";

    if (stream) {
      // 🔧 优化响应头设置
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
        'Content-Encoding': 'identity' // 防止压缩缓冲
      });
      res.flushHeaders?.();
    }

    const requestData = {
      input: { prompt: message, session_id: sessionId },
      parameters: { 
        incremental_output: true,
        // 添加流式控制参数
        stream_interval: 100,
        max_tokens: 2048
      },
    };

    const config = {
      method: 'post',
      url: `https://dashscope.aliyuncs.com/api/v1/apps/${APP_ID}/completion`,
      headers: {
        'Authorization': `Bearer ${process.env.DASHSCOPE_API_KEY}`,
        'Content-Type': 'application/json',
        'X-DashScope-SSE': stream ? 'enable' : 'disable',
        'Accept': 'text/event-stream' // 明确接受流式响应
      },
      data: requestData,
      responseType: stream ? 'stream' : 'json',
      timeout: 0, // 流式请求设置为不超时
      // 🔧 重要：禁用axios的响应转换
      transformResponse: [data => data],
      // 优化http客户端设置
      httpAgent: new (require('http').Agent)({ 
        keepAlive: true,
        maxSockets: 1 // 限制连接数避免竞争
      }),
    };

    const response = await axios(config);

    if (stream) {
      const sseTransform = new SSETransform();
      
      // 管道式处理，避免数据堆积
      response.data.pipe(sseTransform);
      
      let lastFlushTime = Date.now();
      const FLUSH_INTERVAL = 50; // 50ms刷新间隔
      
      sseTransform.on('data', (chunk) => {
        const now = Date.now();
        
        // 立即写入基础数据
        res.write(chunk);
        
        // 控制flush频率，平衡实时性和性能
        if (now - lastFlushTime >= FLUSH_INTERVAL) {
          if (typeof res.flush === 'function') {
            res.flush();
          } else {
            res.socket?.cork(); // 收集数据
            process.nextTick(() => res.socket?.uncork()); // 下一Tick统一发送
          }
          lastFlushTime = now;
        }
      });

      sseTransform.on('end', () => {
        // 发送结束前强制flush
        if (typeof res.flush === 'function') res.flush();
        res.write('data: [DONE]\n\n');
        res.end();
      });

      sseTransform.on('error', (error) => {
        console.error('SSE转换错误:', error);
        try {
          res.write('data: {"error": "流处理异常"}\n\n');
          res.end();
        } catch (e) {}
      });

      req.on('close', () => {
        sseTransform.destroy();
        response.data.destroy();
      });
      
    } else {
      const aiReply = response.data.output.text;
      res.send(resultData({ response: aiReply }));
    }

  } catch (error) {
    console.error('AI 请求错误:', error.message);
    
    if (stream) {
      try {
        // 发送格式化错误信息
        res.write(`data: ${JSON.stringify({ error: "服务异常", message: error.message })}\n\n`);
        res.end();
      } catch (e) {}
    } else {
      res.status(500).send(resultData(null, 500, 'AI 服务异常'));
    }
  }
};