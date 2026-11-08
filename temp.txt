const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { WebSocket, createWebSocketStream } = require('ws');

// ---------------------------------------------------------------------------
// 配置读取优先级：命令行参数 (--uuid xxx) > 环境变量 (UUID=xxx) > 代码默认值
// ---------------------------------------------------------------------------
// 代码里的默认值：没有传任何参数时使用
const DEFAULTS = {
  UUID:     '0ff0350e-c001-495b-a6a1-13b962590375',
  DOMAIN:   'www.baidu.com', // 项目域名或已反代的域名，不带前缀，建议填已反代的域名
  NAME:     'nodejs',
  PORT:     9527,
  CF_TOKEN: '',              // Cloudflare Tunnel token，留空则不启动 cloudflared
};

// 解析命令行参数，支持两种写法：
//   --uuid xxx          (空格分隔)
//   --uuid=xxx          (等号分隔，只在第一个 = 处切分，值里可以含 =)
// 用法示例： docker run image --uuid abc --port 8080
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const eqIdx = key.indexOf('=');
      if (eqIdx !== -1) {
        // 等号写法：只在第一个 = 处切分，后面的 = 保留在值里
        // 这样 --cf-token=eyJhIjoi...== 不会丢掉 base64 填充符
        const k = key.slice(0, eqIdx);
        const v = key.slice(eqIdx + 1);
        args[k.toUpperCase()] = v;
      } else {
        // 空格写法：下一个 token 不是另一个 --flag，就当作当前 flag 的值
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          args[key.toUpperCase()] = next;
          i++;
        }
      }
    }
  }
  return args;
}

const cliArgs = parseArgs(process.argv.slice(2));

// 合并三层来源：命令行 > 环境变量 > 默认值
const UUID     = cliArgs.UUID     || process.env.UUID     || DEFAULTS.UUID;
const DOMAIN   = cliArgs.DOMAIN   || process.env.DOMAIN   || DEFAULTS.DOMAIN;
const NAME     = cliArgs.NAME     || process.env.NAME     || DEFAULTS.NAME;
const port     = Number(cliArgs.PORT || process.env.PORT || DEFAULTS.PORT);  // 本服务监听端口
const CF_TOKEN = cliArgs.CF_TOKEN || process.env.CF_TOKEN || DEFAULTS.CF_TOKEN;  // Cloudflare Tunnel token

const uuid = UUID.replace(/-/g, "");

// 启动时把 index.html 读进内存，避免每次请求都读磁盘
const htmlPath = path.join(__dirname, 'index.html');
let indexPage = '';
try {
  indexPage = fs.readFileSync(htmlPath, 'utf-8');
} catch (e) {
  indexPage = 'Hello, World\n';  // index.html 不存在时退回原始默认行为
  console.warn(`[warn] index.html not found at ${htmlPath}, fallback to plain text`);
}

// 启动时打印一次生效的配置，方便排查（UUID / token 只打前 8 位，避免完整泄露）
console.log(`[config] UUID=${UUID.slice(0, 8)}... DOMAIN=${DOMAIN} NAME=${NAME} PORT=${port}`);
console.log(`[config] CF_TOKEN=${CF_TOKEN ? CF_TOKEN.slice(0, 8) + '...' : '(empty, tunnel disabled)'}`);

// ---------------------------------------------------------------------------
// Cloudflare Tunnel（cloudflared 子进程）
// 有 token 才启动；没 token 直接跳过，不影响主服务
// ---------------------------------------------------------------------------
let cloudflared = null;

// 下载文件（自动跟随 301/302 重定向，GitHub releases 会跳转）
function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向次数过多'));
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    }).on('error', reject);
  });
}

// 确保 cloudflared 二进制可用：PATH 里有就用 → 本地有就用 → 都没有就下载
async function ensureCloudflared() {
  // 1. 检查 PATH 中是否已有 cloudflared（系统安装过的情况）
  try {
    const inPath = execSync('which cloudflared 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (inPath) {
      console.log(`[cloudflared] 使用系统已安装的二进制: ${inPath}`);
      return inPath;
    }
  } catch {}

  // 2. 检查本地是否之前下载过（缓存在 index.js 同目录下）
  const localPath = path.join(__dirname, 'cloudflared');
  if (fs.existsSync(localPath)) {
    console.log(`[cloudflared] 使用已下载的二进制: ${localPath}`);
    return localPath;
  }

  // 3. 自动下载
  const archMap = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' };
  const cfArch = archMap[process.arch];
  if (!cfArch) {
    console.error(`[cloudflared] 不支持的 CPU 架构: ${process.arch}`);
    return null;
  }

  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cfArch}`;
  console.log(`[cloudflared] 正在下载二进制 (${process.arch} → ${cfArch})...`);

  // 先下载到临时文件，成功后再 rename，避免下载中断留下残缺文件被下次误用
  const tempPath = localPath + '.tmp';
  try {
    await downloadFile(url, tempPath);
    fs.renameSync(tempPath, localPath);   // 原子重命名，到这一步文件才完整
    fs.chmodSync(localPath, 0o755);       // 赋予执行权限
    console.log(`[cloudflared] 下载完成: ${localPath}`);
    return localPath;
  } catch (err) {
    // 清理可能残留的临时文件
    try { fs.unlinkSync(tempPath); } catch {}
    console.error(`[cloudflared] 下载失败: ${err.message}`);
    return null;
  }
}

// 启动 cloudflared 隧道
async function startCloudflared(token) {
  const binaryPath = await ensureCloudflared();
  if (!binaryPath) {
    console.error('[cloudflared] 无法获取二进制，隧道未启动（主服务不受影响）');
    return;
  }

  console.log('[cloudflared] 正在启动隧道...');
  cloudflared = spawn(binaryPath, ['tunnel', '--no-autoupdate', 'run', '--token', token]);

  // 把 cloudflared 的日志透传到主进程，加前缀便于区分
  cloudflared.stdout.on('data', (data) => {
    data.toString().split('\n').forEach(line => {
      if (line.trim()) console.log(`[cloudflared] ${line}`);
    });
  });
  cloudflared.stderr.on('data', (data) => {
    data.toString().split('\n').forEach(line => {
      if (line.trim()) console.error(`[cloudflared] ${line}`);
    });
  });

  cloudflared.on('error', (err) => {
    console.error('[cloudflared] 启动失败:', err.message);
  });

  cloudflared.on('exit', (code, signal) => {
    console.log(`[cloudflared] 进程退出 code=${code} signal=${signal}`);
  });
}

if (CF_TOKEN) {
  startCloudflared(CF_TOKEN);  // 异步启动，不阻塞主服务
} else {
  console.log('[cloudflared] 未提供 CF_TOKEN，隧道未启用');
}

// 主进程退出时带走 cloudflared，避免孤儿进程
function cleanup() {
  if (cloudflared && !cloudflared.killed) {
    cloudflared.kill('SIGTERM');
  }
  process.exit();
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------
const httpServer = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(indexPage);
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

// ---------------------------------------------------------------------------
// WebSocket 服务器（VLESS 协议）
// ---------------------------------------------------------------------------
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
      const targetPort = msg.slice(i, i += 2).readUInt16BE(0);  // 客户端要连接的目标端口
      const ATYP = msg.slice(i, i += 1).readUInt8();
      const host = ATYP === 1 ? msg.slice(i, i += 4).join('.') :
        (ATYP === 2 ? new TextDecoder().decode(msg.slice(i + 1, i += 1 + msg.slice(i, i + 1).readUInt8())) :
          (ATYP === 3 ? msg.slice(i, i += 16).reduce((s, b, i, a) => (i % 2 ? s.concat(a.slice(i - 1, i + 1)) : s), []).map(b => b.readUInt16BE(0).toString(16)).join(':') : ''));
      // 建立连接成功，发送回应
      ws.send(new Uint8Array([VERSION, 0]));
      const duplex = createWebSocketStream(ws);
      net.connect({ host, port: targetPort }, function () {
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
