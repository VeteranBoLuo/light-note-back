// 阿里云百炼API的配置信息（流式输出版本）
const https = require('https');
const { resultData } = require('../util/common');

// 核心的聊天接口（流式输出）
exports.receiveMessage = (req, res) => {
  try {
    const { message, stream = false } = req.body; // 添加stream参数

    const BAILIAN_CONFIG = {
      hostname: 'dashscope.aliyuncs.com',
      path: '/compatible-mode/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DASHSCOPE_API_KEY}`
      }
    };

    // 构建请求数据，启用流式输出
    const requestData = JSON.stringify({
      model: "qwen-plus",
      messages: [{ role: "user", content: message }],
      stream: stream // 根据前端请求决定是否启用流式
    });

    // 设置SSE响应头
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
    }

    const apiRequest = https.request(BAILIAN_CONFIG, (apiResponse) => {
      if (stream) {
        // 流式输出处理
        apiResponse.on('data', (chunk) => {
          const lines = chunk.toString().split('\n');
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.substring(6);
              
              if (data === '[DONE]') {
                res.write('data: [DONE]\n\n');
                res.end();
                return;
              }
              
              try {
                // 直接转发百炼API的流式响应
                res.write(`data: ${data}\n\n`);
              } catch (error) {
                console.error('流式数据转发错误:', error);
              }
            }
          }
        });
        
        apiResponse.on('end', () => {
          console.log('流式传输结束');
        });
      } else {
        // 非流式输出（保持原有逻辑）
        let data = '';
        apiResponse.on('data', (chunk) => {
          data += chunk;
        });
        
        apiResponse.on('end', () => {
          try {
            const parsedData = JSON.parse(data);
            
            if (parsedData.error) {
              res.send(resultData(null, 500, 'API错误: ' + parsedData.error.message));
              return;
            }
            
            const aiReply = parsedData.choices[0].message.content;
            res.send(resultData({ response: aiReply }));
          } catch (error) {
            res.send(resultData(null, 500, '解析AI响应失败'));
          }
        });
      }
    });

    // 错误处理（保持不变）
    apiRequest.on('error', (error) => {
      if (stream) {
        res.write('data: {"error": "请求失败"}\n\n');
        res.end();
      } else {
        res.send(resultData(null, 500, '网络请求失败'));
      }
    });

    apiRequest.setTimeout(30000, () => {
      if (stream) {
        res.write('data: {"error": "请求超时"}\n\n');
        res.end();
      } else {
        res.send(resultData(null, 500, '请求超时'));
      }
      apiRequest.destroy();
    });

    apiRequest.write(requestData);
    apiRequest.end();
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常：' + e.message));
  }
};