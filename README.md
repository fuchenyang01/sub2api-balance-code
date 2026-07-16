# sub2api 余额兑换码工具

让指定的 sub2api 分销代理把自己的账户余额按 `1:1` 转成兑换码。代理自助开码，站长不再逐笔处理。

> 独立部署，不修改 sub2api 源码，不向用户暴露管理员 API Key。

## 赞助商

<div align="center">
  <a href="https://www.cyapi.cyou/">
    <img src="docs/images/cyapi-logo.png" width="120" alt="CYAPI">
  </a>
  <h3><a href="https://www.cyapi.cyou/">CYAPI｜一站式 AI 调用平台</a></h3>
  <p>支持主流模型、按量计费、统一 API 接入与在线生图。</p>
  <p><a href="https://www.cyapi.cyou/"><strong>立即访问 CYAPI</strong></a></p>
</div>

## 界面预览

![余额兑换码工具界面](docs/images/balance-code-interface.png)

## 它解决什么问题

sub2api 站长可以直接创建兑换码，但分销代理没有管理后台权限。代理账户里即使已经有余额，每次开码仍要联系站长。

本工具给指定分销分组增加一个受限入口：

- 代理只能转换自己的真实余额；
- 站长通过专属分组决定谁能使用；
- 普通用户无法绕过服务端权限检查；
- 管理员 API Key 只保存在工具服务器中。

## 核心功能

- **分组授权**：只有指定的 sub2api 专属分组可以兑换。
- **1:1 转换**：兑换码总额等于实际扣除的用户余额。
- **批量生成**：自定义单码面值和数量，一次最多 100 张。
- **整批一笔**：一批只执行一次生成请求和一次总额扣款。
- **实时余额**：成功后重新读取 sub2api 的真实余额。
- **内嵌可用**：支持 sub2api 自定义菜单和同站点 iframe。
- **兼容复制**：iframe 限制剪贴板时自动使用备用复制方式。
- **操作恢复**：网络或上游结果不明确时保留原操作继续处理。

## 工作流程

1. 用户登录 sub2api，并从自定义菜单进入工具。
2. 工具使用登录 JWT 读取真实用户、余额和分组。
3. 用户输入单码面值和数量，确认总扣款。
4. 工具一次生成整批兑换码，再扣除对应总额。
5. 页面显示兑换码并刷新实时余额。

浏览器提交的用户 ID、余额和分组都不会被当作可信数据。服务端会在关键步骤重新向 sub2api 验证。

## 快速部署

下面以 Ubuntu/Debian、Docker、Nginx 和同站点 HTTPS 子域为例。

### 1. 准备信息

开始前需要：

- 一个已运行的 sub2api 站点；
- 一个以 `admin-` 开头的 sub2api 管理员 API Key；
- 一个“专属分组”及其数字 ID，例如 `#24` 对应 `24`；
- 一个工具域名，例如 `code.example.com`；
- 一台已放行 `22`、`80`、`443` 端口的服务器。

需要 iframe 内嵌时，sub2api 与工具必须使用同一主域下的 HTTPS 子域，例如 `sub.example.com` 和 `code.example.com`。

实际示例：`https://www.cyapi.cyou` 与 `https://code.cyapi.cyou` 可以内嵌；`https://www.cyapi.cyou` 与 `http://localhost:5173` 不同站，本地调试应使用“新窗口打开”。

安装基础软件：

```bash
sudo apt update
sudo apt install -y git docker.io nginx certbot python3-certbot-nginx openssl curl
sudo systemctl enable --now docker nginx
```

> 管理员 API Key 只能放在服务器 `.env` 中，不能写进菜单 URL、浏览器代码或 Git 仓库。

### 2. 创建分销专属分组

在 sub2api 管理后台完成两件事：

1. 在“分组管理”创建或选择一个已启用的**专属分组**，记下数字 ID，`#24` 对应配置值 `24`；
2. 在“用户管理 → 分组配置”中，把允许自助开码的用户加入该分组。

工具只根据用户实时 profile 中的 `allowed_groups` 判断权限。工具无法确认该分组是否为“启用”或“专属”，管理员必须在 sub2api 后台正确配置；公开分组不适合作为授权边界。

### 3. 下载项目

```bash
sudo mkdir -p /opt/sub2api-balance-code
sudo chown "$USER":"$USER" /opt/sub2api-balance-code
git clone https://github.com/fuchenyang01/sub2api-balance-code.git /opt/sub2api-balance-code
cd /opt/sub2api-balance-code
cp .env.example .env
```

生成两条不同的随机密钥：

```bash
openssl rand -hex 32
openssl rand -hex 32
```

### 4. 配置 `.env`

编辑 `.env`：

```dotenv
NODE_ENV=production
SUB2API_BASE_URL=https://sub.example.com
SUB2API_ADMIN_API_KEY=REPLACE_ME_ADMIN_KEY
REDEEM_ALLOWED_GROUP_ID=24
APP_ORIGIN=https://code.example.com
SUB2API_ORIGIN=https://sub.example.com
SESSION_SECRET=REPLACE_WITH_FIRST_RANDOM_VALUE
OPERATION_SIGNING_SECRET=REPLACE_WITH_SECOND_RANDOM_VALUE
PORT=3000
OPERATION_TTL_MINUTES=60
UPSTREAM_TIMEOUT_MS=10000
TRUST_PROXY=true
LOG_LEVEL=info
COOKIE_SECURE=true
```

必须确认：

- `SUB2API_BASE_URL` 和 `SUB2API_ORIGIN` 是 sub2api 的 HTTPS origin，不加 `/api/v1`；
- `APP_ORIGIN` 是工具的 HTTPS origin，不带路径；
- `REDEEM_ALLOWED_GROUP_ID` 只填数字，不带 `#`；
- 两条 secret 至少 32 字节且不能相同。

限制配置权限：

```bash
chmod 600 .env
```

### 5. 构建并启动单个容器

```bash
sudo docker build -t sub2api-balance-code:local .

sudo docker run -d \
  --name sub2api-balance-code \
  --env-file .env \
  -p 127.0.0.1:3100:3000 \
  --restart unless-stopped \
  sub2api-balance-code:local
```

检查本机健康状态：

```bash
curl -fsS http://127.0.0.1:3100/healthz && echo
```

正常返回：

```json
{"status":"ok"}
```

不要把端口改成 `0.0.0.0:3100:3000`，工具只能通过本机 Nginx 对外提供服务。

如果 `.env` 改为 `PORT=4000`，Docker 映射也必须改为 `-p 127.0.0.1:3100:4000`。

### 6. 配置 Nginx 和 HTTPS

入口 URL 会短暂携带用户 JWT。Nginx 日志必须只记录 `$uri`，不能记录完整查询参数。

创建日志格式：

```bash
sudo tee /etc/nginx/conf.d/no-query-log.conf > /dev/null <<'EOF'
log_format without_query '$remote_addr - $remote_user [$time_local] '
                         '"$request_method $uri $server_protocol" $status $body_bytes_sent';
EOF
```

创建站点配置，把 `code.example.com` 换成真实工具域名：

```bash
sudo tee /etc/nginx/sites-available/sub2api-balance-code > /dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name code.example.com;

    access_log /var/log/nginx/sub2api-balance-code.access.log without_query;
    error_log /var/log/nginx/sub2api-balance-code.error.log warn;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/sub2api-balance-code \
  /etc/nginx/sites-enabled/sub2api-balance-code
sudo nginx -t
sudo systemctl reload nginx
```

申请证书：

```bash
sudo certbot --nginx -d code.example.com --redirect
```

验证公网健康接口：

```bash
curl -fsS https://code.example.com/healthz && echo
```

### 7. 添加 sub2api 自定义菜单

在 sub2api 管理后台进入“系统设置 → 常规 → 自定义菜单”，添加：

| 字段 | 值 |
| --- | --- |
| 名称 | `余额转换` |
| 可见范围 | 用户可见 |
| URL | `https://code.example.com` |

URL 只填工具根地址。不要手工添加 Token、用户 ID 或管理员 API Key。

sub2api 菜单本身不能按专属分组隐藏，因此未授权用户可能看见入口，但服务端会返回 `403 / REDEEM_ACCESS_DENIED`。

权限不正确时，只检查四项：确认分组是已启用的专属分组、确认用户已勾选该分组、确认 `.env` 中的数字 ID 正确、修改配置后删除并重建容器。`REDEEM_ALLOWED_GROUP_ID` 与实际分组 ID 不一致时，服务可以启动，但用户会显示无权限。用户被移出分组后会立即失去权限；重新加入分组后，在页面点击“重新检查”。

### 8. 小额验收

正式开放前，使用普通测试用户检查：

1. 已加入专属分组的用户可以进入；
2. 未加入分组的用户显示“暂无余额兑换权限”；
3. 小额生成 2 张码时，只扣一次总额；
4. 兑换成功后余额自动刷新；
5. iframe 和“新窗口打开”都能使用；
6. 公网 `/healthz` 仍返回 `{"status":"ok"}`。

## 必要配置

| 变量 | 用途 |
| --- | --- |
| `SUB2API_BASE_URL` | sub2api API 根地址 |
| `SUB2API_ADMIN_API_KEY` | 服务端管理员 API Key |
| `REDEEM_ALLOWED_GROUP_ID` | 允许兑换的专属分组数字 ID |
| `APP_ORIGIN` | 工具对外访问 origin |
| `SUB2API_ORIGIN` | sub2api origin，用于来源校验和 iframe CSP |
| `SESSION_SECRET` | 加密用户会话，至少 32 字节 |
| `OPERATION_SIGNING_SECRET` | 签名操作令牌，至少 32 字节且不能复用会话密钥 |
| `TRUST_PROXY` | 本机 Nginx 反代时设为 `true` |
| `COOKIE_SECURE` | 生产环境必须为 `true` |

其他超时、日志和端口配置见 [.env.example](.env.example)。

## 日常维护

查看状态和日志：

```bash
sudo docker ps --filter name=sub2api-balance-code
sudo docker logs --tail 100 sub2api-balance-code
```

升级并重建：

```bash
cd /opt/sub2api-balance-code
git pull --ff-only
```

对照最新的 `.env.example`，确认 `.env` 中存在以下配置，并按实际专属分组 ID 填写。缺少该变量会导致新容器拒绝启动。

```dotenv
REDEEM_ALLOWED_GROUP_ID=24
```

然后构建并替换旧容器：

```bash
sudo docker build -t sub2api-balance-code:local .
sudo docker rm -f sub2api-balance-code
sudo docker run -d \
  --name sub2api-balance-code \
  --env-file .env \
  -p 127.0.0.1:3100:3000 \
  --restart unless-stopped \
  sub2api-balance-code:local
```

修改 `.env` 后也必须删除并重建容器，单独执行 `docker restart` 不会加载新配置。

## 重要限制

> [!WARNING]
> 本工具处理真实余额。请先用测试账号和小额余额验收。

- **只能运行一个实例**：用户锁位于 Node.js 进程内，不支持多容器或水平扩容。
- **生成与扣款不是同一事务**：极端断电、超时或上游部分失败时，可能需要人工核对。
- **不要盲目重试待确认操作**：应使用原操作继续处理，或按原幂等键核对上游结果。
- **必须使用 HTTPS**：生产环境 Cookie 和 iframe 依赖同站点 HTTPS。
- **历史记录保存在浏览器**：不是服务器备份，也不会跨设备同步。

## 本地开发

需要 Node.js 22 或更高版本。

```bash
cp .env.example .env
npm ci
npm run dev
```

另开一个终端启动前端：

```bash
npm run dev:web
```

浏览器打开 `http://localhost:5173`。本地调试时将 `.env` 中的 `APP_ORIGIN` 设为该地址，并设置 `COOKIE_SECURE=false`。

同时把 `.env` 中的示例域名、管理员 Key 和两条 secret 替换为实际开发配置，并设置 `NODE_ENV=development`。

运行检查：

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

## 开源地址

[https://github.com/fuchenyang01/sub2api-balance-code](https://github.com/fuchenyang01/sub2api-balance-code)
