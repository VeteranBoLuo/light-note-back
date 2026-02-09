import axios from 'axios';
import { resultData } from '../util/common.js';
import { Transform } from 'stream';
import { Agent as HttpAgent } from 'http';

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

export const receiveMessage = async (req, res) => {
  req.setTimeout(0);

  // 在函数作用域顶部声明变量，确保catch块可以访问
  let stream = false;

  try {
    const {
      message,
      sessionId = '',
      useInternetSearch = false,
      enableThinking = false,
      enableTranslation = false,
      translationConfig = {},
    } = req.body;
    stream = req.body.stream ?? false; // 提取到外层作用域
    const APP_ID = 'ff8422dbcc784e8ba170b8ed0408c19b';

    // 语言映射
    const langMap = {
      auto: '自动识别',
      zh: '中文',
      en: '英文',
      ja: '日文',
      ko: '韩文',
      fr: '法文',
      de: '德文',
      es: '西班牙文',
    };

    // 构建 prompt
    let prompt = message;
    if (enableTranslation) {
      const { source = 'auto', target = 'en' } = translationConfig;
      const sourceLang = source === 'auto' ? '' : langMap[source] || source;
      const targetLang = langMap[target] || target;
      const prefix = sourceLang ? `将以下${sourceLang}内容翻译成${targetLang}：` : `将以下内容翻译成${targetLang}：`;
      prompt = prefix + message;
    }

    if (stream) {
      // 🔧 优化响应头设置
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
        'Content-Encoding': 'identity', // 防止压缩缓冲
      });
      res.flushHeaders?.();
    }

    const requestData = {
      input: { prompt: prompt, session_id: sessionId },
      parameters: {
        incremental_output: true,
        model: 'qwen-plus', // 显式指定模型名称
        stream_interval: 100,
        max_tokens: 4096,
        enable_web_search: useInternetSearch,
        has_thoughts: enableThinking,
        enable_thinking: enableThinking,
      },
    };

    const config = {
      method: 'post',
      url: `https://dashscope.aliyuncs.com/api/v1/apps/${APP_ID}/completion`,
      headers: {
        Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
        'Content-Type': 'application/json',
        'X-DashScope-SSE': stream ? 'enable' : 'disable',
        Accept: 'text/event-stream', // 明确接受流式响应
      },
      data: requestData,
      responseType: stream ? 'stream' : 'json',
      timeout: 30000, // 设置30秒超时
      // 🔧 重要：禁用axios的响应转换
      transformResponse: [(data) => data],
      // 优化http客户端设置
      httpAgent: new HttpAgent({
        keepAlive: true,
        maxSockets: 1, // 限制连接数避免竞争
      }),
    };

    // 添加超时处理
    const response = await Promise.race([
      axios(config),
      new Promise((_, reject) => setTimeout(() => reject(new Error('请求超时，请稍后重试')), 30000)),
    ]);

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
        res.write(`data: ${JSON.stringify({ error: '服务异常', message: error.message })}\n\n`);
        res.end();
      } catch (e) {}
    } else {
      res.status(500).send(resultData(null, 500, 'AI 服务异常: ' + error.message));
    }
  }
};

export const generateBookmarkDescription = async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).send(resultData(null, 400, '缺少URL参数'));
    }

    // 验证URL格式
    const urlRegex = /^https?:\/\/.+/;
    if (!urlRegex.test(url)) {
      return res.send(resultData(null, 400, '请输入正确的书签地址'));
    }

    const APP_ID = 'ff8422dbcc784e8ba170b8ed0408c19b';

    const prompt = `${url}你是专门用于根据url生成描述的接口不要调用知识库，直接输出这个url的简短纯文字描述，不要二维码、链接或其他内容,直接说描述内容，同时回答时不要带上该链接为，该网页为等类似措辞。`;

    const requestData = {
      input: { prompt: prompt },
      parameters: {
        incremental_output: false,
        model: 'qwen-plus', // 显式指定模型名称
        max_tokens: 512,
        enable_web_search: false,
        has_thoughts: false,
        enable_thinking: false,
      },
    };

    const config = {
      method: 'post',
      url: `https://dashscope.aliyuncs.com/api/v1/apps/${APP_ID}/completion`,
      headers: {
        Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: requestData,
      responseType: 'json',
      timeout: 30000,
    };

    const response = await axios(config);
    const description = response.data.output.text;
    res.send(resultData({ description: description }));
  } catch (error) {
    console.error('生成描述错误:', error.message);
    res.status(500).send(resultData(null, 500, '生成描述失败: ' + error.message));
  }
};
