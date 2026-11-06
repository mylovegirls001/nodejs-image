<div align="center">

# Node-ws
基于serverless实现的vless,轻量，无内核。

---

</div>

* 用于node环境的玩具和容器，基于node三方ws库，vless，可自行添加环境变量

* 域名/sub查看节点信息，非标端口，域名:端口/sub

## Docker 运行参数说明

本镜像支持通过 **环境变量** 或 **命令行参数** 覆盖默认配置，优先级：

```
命令行参数 (--uuid)  >  环境变量 (-e UUID=)  >  代码默认值
```

| 参数 | 环境变量 | 命令行参数 | 默认值 | 说明 |
|------|----------|-----------|--------|------|
| UUID | `UUID` | `--uuid` | `6a1fb68a-40ba-4005-8597-9c78fd519e59` | 节点 UUID |
| DOMAIN | `DOMAIN` | `--domain` | `www.baidu.com` | 项目域名或反代域名，不带 `https://` |
| NAME | `NAME` | `--name` | `nodejs` | 节点名称（订阅里显示的备注名） |
| PORT | `PORT` | `--port` | `9527` | 监听端口 |
| CF_TOKEN | `CF_TOKEN` | `--cf-token` | （空） | Cloudflare Tunnel token，留空则不启动隧道 |

### 方式一：环境变量（推荐，最简单）

```bash
docker run -d \
  -p 8080:9527 \
  -e UUID=11111111-2222-3333-4444-555555555555 \
  -e DOMAIN=your.domain.com \
  -e NAME=my-node \
  -e PORT=9527 \
  -e CF_TOKEN=your-cloudflare-tunnel-token \
  ghcr.io/<owner>/hunode:latest
```

不传任何 `-e` 时，全部走代码里的默认值，行为和原来完全一致。
不传 `CF_TOKEN` 时，cloudflared 不启动，只有 HTTP + WebSocket 服务。

### 方式二：命令行参数

```bash
docker run -d \
  -p 8080:9527 \
  ghcr.io/<owner>/hunode:latest \
  --uuid 11111111-2222-3333-4444-555555555555 \
  --domain your.domain.com \
  --name my-node \
  --port 9527 \
  --cf-token your-cloudflare-tunnel-token
```

也支持等号写法：`--uuid=xxx --port=8080 --cf-token=xxx`。

### 方式三：env-file（参数多时更清爽）

先写一个 `.env` 文件：

```env
UUID=11111111-2222-3333-4444-555555555555
DOMAIN=your.domain.com
NAME=my-node
PORT=9527
CF_TOKEN=your-cloudflare-tunnel-token
```

然后：

```bash
docker run -d -p 8080:9527 --env-file .env ghcr.io/<owner>/hunode:latest
```

> 注意：`-p 8080:9527` 左边是宿主机端口，右边是容器内端口。如果你用 `--port 3000` 改了容器内监听端口，记得 `-p` 右边也要改成 3000，否则映射不上。

### Cloudflare Tunnel 说明

`CF_TOKEN` 是在 Cloudflare Zero Trust 面板创建 Named Tunnel 后拿到的 token。
隧道的 ingress 规则（把哪个域名代理到本地哪个端口）在 Cloudflare 面板上配置，
代码里只负责用 token 启动 `cloudflared tunnel run`。

启用隧道后，`docker logs` 里会看到 `[cloudflared]` 前缀的日志。

cloudflared 二进制由 index.js 在运行时自动获取，无需手动安装：
- PATH 中已有 → 直接使用（系统装过的情况）
- 本地已下载过 → 使用缓存（index.js 同目录下的 `cloudflared` 文件）
- 都没有 → 自动从 GitHub 下载对应架构的二进制，缓存到本地

### 不用 Docker（pm2 直接运行）

```bash
npm install                          # 先装依赖
CF_TOKEN=xxx pm2 start index.js --name vless-node
```

pm2 方式无需手动安装 cloudflared，index.js 会自动下载。
注意用 fork 模式（pm2 默认），不要用 cluster 模式（`-i` 参数），WebSocket 长连接不兼容多进程。

* 温馨提示：READAME.md为说明文件，请不要上传。
* js混肴地址：https://obfuscator.io

### 使用cloudflare workers 或 snippets 反代域名给节点套cdn加速
```
export default {
    async fetch(request, env) {
        let url = new URL(request.url);
        if (url.pathname.startsWith('/')) {
            var arrStr = [
                'change.your.domain', // 此处单引号里填写你的节点伪装域名
            ];
            url.protocol = 'https:'
            url.hostname = getRandomArray(arrStr)
            let new_request = new Request(url, request);
            return fetch(new_request);
        }
        return env.ASSETS.fetch(request);
    },
};
function getRandomArray(array) {
  const randomIndex = Math.floor(Math.random() * array.length);
  return array[randomIndex];
}
```


## 开源协议说明（基于GPL）

本项目遵循 GNU 通用公共许可证（GNU General Public License, 简称 GPL）发布，并附加以下说明：

1. 你可以自由地使用、复制、修改和分发本项目的源代码，前提是你必须保留原作者的信息及本协议内容；
2. 修改后的版本也必须以相同协议开源；
3. **未经原作者明确授权，不得将本项目或其任何部分用于商业用途。**

商业用途包括但不限于：
- 将本项目嵌入到出售的软件、系统或服务中；
- 通过本项目直接或间接获利（例如通过广告、SaaS服务等）；
- 在公司或组织内部作为商业工具使用。

如需获得商业授权，请联系原作者：[admin@eooce.com]

版权所有 ©2025 `eooce`

---
