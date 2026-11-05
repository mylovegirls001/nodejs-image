const http = require('http');
const net = require('net');
const { WebSocket, createWebSocketStream } = require('ws');

const UUID = process.env.UUID || '0ff0350e-c001-495b-a6a1-13b962590375';
const uuid = UUID.replace(/-/g, "");
const DOMAIN = process.env.DOMAIN || 'www.baidu.com';  // 项目域名或已反代的域名，不带前缀，建议填已反代的域名
const NAME = process.env.NAME || 'nodejs';
const port = process.env.PORT || 9527;  // 端口

// 创建HTTP路由
const httpServer = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Hello, World\n');
  } else if (req.url === '/sub') {
    const vlessURL = `vless://${UUID}@${DOMAIN}:443?encryption=none&security=tls&sni=${DOMAIN}&type=ws&host=${DOMAIN}&path=%2F#${NAME}`;
    
    const base64Content = Buffer.from(vlessURL).toString('base64');

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(base64Content + '\n');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found\n');
  }
});

httpServer.listen(port);  // 启动 HTTP 服务

// WebSocket 服务器
const wss = new WebSocket.Server({ server: httpServer });
wss.on('connection', ws => {
  // WebSocket 连接成功
  ws.on('message', msg => {
    if (msg.length < 18) {
      // 数据长度无效
      return;
    }
    try {
      const [VERSION] = msg;
      const id = msg.slice(1, 17);
      if (!id.every((v, i) => v == parseInt(uuid.substr(i * 2, 2), 16))) {
        // UUID 验证失败
        return;
      }
      let i = msg.slice(17, 18).readUInt8() + 19;
      const port = msg.slice(i, i += 2).readUInt16BE(0);
      const ATYP = msg.slice(i, i += 1).readUInt8();
      const host = ATYP === 1 ? msg.slice(i, i += 4).join('.') :
        (ATYP === 2 ? new TextDecoder().decode(msg.slice(i + 1, i += 1 + msg.slice(i, i + 1).readUInt8())) :
          (ATYP === 3 ? msg.slice(i, i += 16).reduce((s, b, i, a) => (i % 2 ? s.concat(a.slice(i - 1, i + 1)) : s), []).map(b => b.readUInt16BE(0).toString(16)).join(':') : ''));
      // 建立连接成功，发送回应
      ws.send(new Uint8Array([VERSION, 0]));
      const duplex = createWebSocketStream(ws);
      net.connect({ host, port }, function () {
        this.write(msg.slice(i));
        duplex.on('error', () => {}).pipe(this).on('error', () => {}).pipe(duplex);
      }).on('error', () => {});
    } catch {
      // 处理消息时出错
    }
  }).on('error', () => {
    // WebSocket 错误
  });
});