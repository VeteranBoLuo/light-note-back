// websocket.js
const http = require('http');
const WebSocket = require('ws');

const wsServer = http.createServer();
const wss = new WebSocket.Server({ server: wsServer });

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    console.log(`Received message => ${message}`);
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
  });
});

wsServer.listen(3000, () => {
  console.log('WebSocket启动');
});

module.exports = wss;
