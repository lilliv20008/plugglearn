# 部署与访问

服务只有一个 Node 进程 + 一个 SQLite 文件，部署等于：装 Node → 拷目录 → 起进程。

---

## 1. 本机 / 局域网

默认只监听 `0.0.0.0:8710`（`server.js:542` 的 `server.listen(PORT, '0.0.0.0')`），同网段设备可直接访问。

```bash
ipconfig | findstr IPv4        # 找本机内网 IPv4，例如 192.168.1.23
```

- 工作台：`http://192.168.1.23:8710`
- 客户前台：`http://192.168.1.23:8710/app`
- 手机扫码：把上面的地址做成二维码（`qrcode` 或任意在线工具）

Windows 首次访问需要放行 8710：

```powershell
New-NetFirewallRule -DisplayName "plugglearn 8710" -Direction Inbound -Protocol TCP -LocalPort 8710 -Profile Private,Domain -Action Allow
```

> 注意网络类别：连手机热点/家用 WiFi 时通常是 Private；如果是 Public，上面规则不生效，把 `-Profile` 改成 `Any`（或把网络切成专用网络）。

---

## 2. 外网访问（不买服务器）

### 方案 A：Tailscale（推荐，零配置 NAT 穿透）

```powershell
winget install --id Tailscale.Tailscale -e
tailscale up --hostname plugglearn-pc      # 浏览器里登录授权
tailscale status                           # 看 100.x.y.z 地址
```

之后手机装 Tailscale 并登录同一账号，访问 `http://100.x.y.z:8710`。Tailscale 网卡通常是 Private，无需再改防火墙。

### 方案 B：Cloudflare Tunnel（自带域名 + HTTPS）

```powershell
winget install --id Cloudflare.cloudflared -e
cloudflared tunnel login
cloudflared tunnel create plugglearn
cloudflared tunnel route dns plugglearn learn.example.com
cloudflared tunnel run --url http://127.0.0.1:8710 plugglearn
```

好处：不需要开端口，直接拿到 HTTPS 域名，客户前台可以对外发。

---

## 3. 云服务器（Linux）

```bash
# 1) 装 Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# 2) 拷程序（本地执行）
scp -r plugglearn root@SERVER_IP:/opt/

# 3) 起服务
cd /opt/plugglearn
npm start
```

生产用 systemd：

```ini
# /etc/systemd/system/plugglearn.service
[Unit]
Description=plugglearn
After=network.target

[Service]
WorkingDirectory=/opt/plugglearn
ExecStart=/usr/bin/node --no-warnings server.js
Environment=PORT=8710
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now plugglearn
```

Nginx + HTTPS：

```nginx
server {
  listen 80;
  server_name learn.example.com;
  location / {
    proxy_pass http://127.0.0.1:8710;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d learn.example.com
```

有 HTTPS 之后建议：设置里关掉注册，客户账号手工开；Cookie 会议话只在服务端用，不要出现在日志里。

---

## 4. 云服务器（Windows Server）

```powershell
# 装 Node（LTS 22+ 的 msi，或直接解压 zip 后把目录加进 PATH）
winget install OpenJS.NodeJS.LTS

# 拷到 C:\plugglearn，放行端口
New-NetFirewallRule -DisplayName "plugglearn 8710" -Direction Inbound -Protocol TCP -LocalPort 8710 -Profile Any -Action Allow

# 计划任务开机自启（SYSTEM 身份）
$act = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" -Argument "--no-warnings server.js" -WorkingDirectory "C:\plugglearn"
$trg = New-ScheduledTaskTrigger -AtStartup
$set = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName plugglearn -Action $act -Trigger $trg -Settings $set -User SYSTEM -RunLevel Highest
Start-ScheduledTask plugglearn
```

`-ExecutionTimeLimit ([TimeSpan]::Zero)` 不能漏：默认 3 天会把进程杀掉。

---

## 5. 反向代理注意

如果放在 Nginx/IIS 后面：

- 保留 `Host` 头（前端不做绝对跳转，问题不大）。
- 会话 Cookie 是 `SameSite=Lax`，同域访问没问题；跨域嵌入 iframe 会被拦。
- 大文件没有，超时设 60s 足够；任务进度靠前端 8 秒轮询，不需要 WebSocket。

---

## 6. 运行维护

| 事项 | 命令 |
| --- | --- |
| 看状态 | `curl http://127.0.0.1:8710/api/bootstrap` |
| 备份 | 停服务后拷 `data/` 目录 |
| 升级 | 覆盖 `server.js`/`lib`/`public`，重启进程（`data/` 不动） |
| 清空重来 | 删 `data/plugglearn.db*`，重启后重新创建管理员 |
| 日志 | 终端 stdout；执行流水在「记录」页（保留 5000 条） |

---

## 7. 安全清单（对外之前）

- [ ] 改掉初始化时的管理员密码（设置里没有改密码入口，删库重建最省事，或直接改 `users` 表的 `pass_hash`）
- [ ] 关掉「注册开关」，客户账号手工开
- [ ] 上 HTTPS（Cloudflare Tunnel 或 certbot）
- [ ] 不要把 8710 裸奔在公网 IP 上：Cookie 是明文传输
- [ ] `data/` 里存着客户的学习通 Cookie，别传网盘、别进 git
---

## 参考部署（Windows Server 2022 示例）

```
控制台    http://YOUR_SERVER_IP:8710/
客户前台  http://YOUR_SERVER_IP:8710/app
```

机器上的布局（和本机同构，零 npm 依赖）：

```
C:\plugglearn\            源码 + data\（数据库、会话、远程题库配置）
C:\plugglearn\node\       便携版 Node 22.14.0（不写注册表，不碰系统 PATH）
C:\plugglearn\start.cmd   启动脚本（设 PORT=8710，日志落到 server.log）
计划任务 plugglearn        AtStartup / SYSTEM / 重启上限 999 / 无执行时限
防火墙                    入站 TCP 8710
```

**部署边界**：只占用 8710 端口、只写 `C:\plugglearn`、只加一条防火墙规则和一个计划任务，同机其它服务不受影响。

**更新代码**：本地改完重跑一次部署脚本（robocopy 覆盖源码、保留 `data\`，然后重启计划任务）。

**常用运维**：

```powershell
Get-ScheduledTask plugglearn | Get-ScheduledTaskInfo   # 上次结果/时间
Stop-Process -Name node -Force; Start-ScheduledTask plugglearn   # 重启
Get-Content C:\plugglearn\server.log -Tail 40          # 日志
```

## HTTPS 入口（Caddy，已上线）

服务器上原本就有一套 Caddy（给 EasyRun 代理 8080），这次没有另外装，直接在 `C:\Caddy\Caddyfile` 里加了一个站点块，两个服务共用同一个 Caddy、各占一个域名：

```caddyfile
{ admin off, storage C:\Caddy\data, log → C:\Caddy\logs\access.log }

# ① 纯 IP 入口 → EasyRun
:80 {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080 { header_up X-Real-IP {remote_host} }
}

# ② plugglearn → HTTPS（自动签证书）
your-host.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8710
}
```

- 地址：**https://your-host.example.com/** （工作台）、**https://your-host.example.com/app**（客户前台）
- 证书：Let's Encrypt，CN=your-host.example.com，2026-11-13 签发，90 天自动续期（Caddy 内置 ACME，只要 80/443 通就不用管）
- `sslip.io` 是通配解析服务，`your-host.example.com` 天然解析到 `YOUR_SERVER_IP`，不用买域名、不用配 DNS
- 同域名的 http 请求会被 308 跳到 https
- 备份：`C:\Caddy\Caddyfile.bak-20261114`（改动前原件）
- 改完配置必须重启计划任务 `Caddy` 才生效（配置里有 `admin off`，不能用 `caddy reload` 的 API）：

```powershell
Stop-ScheduledTask Caddy; Start-ScheduledTask Caddy
C:\Caddy\caddy.exe validate --config C:\Caddy\Caddyfile --adapter caddyfile   # 改之前先验
```

换成自己的域名时：把 `your-host.example.com` 换成域名，A 记录指向 YOUR_SERVER_IP，其余不动。注意 `某个 .cd 免费域名` 在大陆被 SNI 阻断，别拿它做这个用途。

## 已知坑：服务器上跑无头浏览器

后台服务在 session 0 里，**Edge 起不来**（秒退 code 1002），要换成 Chrome for Testing 并关沙箱。
完整做法见 `docs/BROWSER.md` 第 8 节；线上已经这么配好了
（`C:\plugglearn\chrome\chrome-win64\chrome.exe`，`Browser.launch()` 默认 `--no-sandbox`）。
