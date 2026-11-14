# 插头学堂 · plugglearn

一个自托管的**网课托管工作台**：把学习通（超星）账号的课程章节变成可排队的任务，由后台调度器按计划、按时段、按并发自动推进，工作台上能看到账号状态、计划、任务、执行记录；可选开启**客户前台**（`/app`），让客户自助提交、查看进度。

- 零第三方依赖：只用 Node 内置 `http` + `node:sqlite`，`npm install` 不需要联网。
- 单进程、单文件数据库，拷走 `data/` 就是完整备份。
- 两套界面：`/` 管理台（Apple Music 风格的浅色工作台），`/app` 客户前台（手机友好）。

### 参考部署形态

| | |
|---|---|
| 工作台 | `https://your-host.example.com/`（Caddy 自动 HTTPS） |
| 客户前台 | `https://your-host.example.com/app` |
| 反向代理 | Caddy 反代 `127.0.0.1:8710`，证书 Let's Encrypt 自动续期 |
| 进程 | Windows 计划任务（SYSTEM 开机自启）或 Linux systemd |

细节见 [DEPLOY.md](DEPLOY.md)。

---|---|
| 工作台 | https://your-host.example.com/ |
| 客户前台 | https://your-host.example.com/app |
| 主机 | 阿里云 一台 ECS（Windows Server 2022，与 EasyRun 同机） |
| 端口 | 8710（本机回环），对外由 Caddy 终结 TLS 走 443 |

证书由 Caddy 自动申请续期（Let's Encrypt），详见 [DEPLOY.md](DEPLOY.md) 的「HTTPS 入口」一节。

---

## 1. 快速开始

需要 **Node.js ≥ 22.5**（用到内置 `node:sqlite`；本机实测 Node 24.21）。

```bash
cd plugglearn
node --no-warnings server.js      # 或 npm start / ./start.sh / start.cmd
```

打开 <http://127.0.0.1:8710>，首次进入会要求**创建管理员**（这属于初始化，只需一次）：

```
邮箱：admin@plugglearn.local
密码：your-password-1234          ← 示例，自己填一个 8 位以上的
```

改端口：`PORT=9000 node server.js`（Windows：`set PORT=9000 && node server.js`）。

### 第一次跑通（不用真账号，用模拟环境）

1. 账号 → 新建 → 接入方式选 **模拟环境（sim）** → 保存；
2. 点该行的 **检测** → 显示「模拟会话有效 · 3 门课程」；
3. 计划 → 新建 → 选这个账号、倍速 2、间隔 800ms → 保存；
4. 计划行点 **同步目录** → 生成 19 个任务；
5. 概览里就能看到调度器开始跑：任务状态 `等待 → 执行中 → 完成`。

模拟环境只在本地推进进度、不联网，用来验证调度、并发、时段窗口、失败重试这些逻辑。

---

## 2. 接入真实学习通账号

账号 → 新建 → 接入方式选 **学习通（chaoxing）**，把浏览器里登录后的 Cookie 粘进去。

取 Cookie（Edge/Chrome）：

1. 浏览器登录 <https://mooc1.chaoxing.com>（或 i.chaoxing.com）；
2. F12 → Application/应用 → Cookies → `https://mooc1.chaoxing.com`；
3. 全选复制，形如 `_uid=123456; fid=7890; _d=...; UID=...;`。

需要的字段：`_uid`、`fid`、`_d`（有 `UID`/`vc3` 更好）。粘成一行即可。

保存后点 **检测**：

| 检测结果 | 含义 |
| --- | --- |
| 在线 · N 门课程 | Cookie 有效，可以建计划 |
| Cookie 已失效 / 需要重新登录 | 重新取一次 Cookie |
| 网络错误 | 本机到 mooc1-api.chaoxing.com 不通 |

**同步目录**会读取 `backclazzdata` 拿到课程列表，再逐门抓 `studentcourse` 页面里的 `chapterId`，一门课一个任务点（章节视频）。

**执行**时逐章节打开 `studentstudy?chapterId=...`，解析 `objectid/jobid`，然后按间隔向 `multimedia/log/a/{clazzid}/{objectid}` 上报播放进度，直到接口返回 `isPassed === true` 或达到章节时长上限。

几个现实约束：

- 学习通对上报频率、倍速、并发都敏感。默认全局并发 2、间隔 800ms 已经比较稳；**不要**把全局并发拉到 6 以上、也不要把间隔压到 300ms 以下，否则容易出现「进度不涨」或短时风控。
- 章节里有测验/讨论/作业的，脚本只处理**视频进度**，测验要自己做；任务完成指的是视频看完。
- 会话过期会让一批任务连续失败，调度器会按 `30s × 失败次数²` 退避重试（默认最多 3 次），失败任务可在「任务」页一键重试。

---

## 3. 工作台功能

| 页面 | 做什么 |
| --- | --- |
| 概览 | 账号/任务/今日完成数、调度器状态与并发、最近记录、暂停调度 |
| 账号 | 增删改账号、检测会话、查看最后一次错误 |
| 计划 | 按账号建计划：倍速、单账号并发、间隔、时段窗口（支持跨零点，如 22:00–02:00）、启停；同步目录生成任务、清空未完成任务 |
| 任务 | 按状态/账号/计划/关键词筛选，重试、跳过、删除、批量重试失败 |
| 记录 | 执行流水（info/warn/error），保留最近 5000 条 |
| 订单 | 客户前台的订单：受理 → 自动启用对应计划；关闭 → 停用 |
| 设置 | 全局并发、最大重试、站点名、客户前台开关、注册开关 |

调度器每 2 秒扫一次：取当前时段内、状态 enabled 的计划下 `pending` 且 `next_at` 到期的任务，按「全局并发 / 单账号并发」限制执行；`running` 的任务会在概览实时显示进度。

---

## 4. 客户前台（可选）

设置里打开「客户前台」，把 `http://<你的地址>:8710/app` 发出去：

- 客户自助注册（可关）→ 粘贴自己的 Cookie 提交任务 → 看到「完成数 / 总数 + 进度条」；
- 你在「订单」页受理 → 自动启用该客户的计划，开始执行；关闭则停用。

前台看不到任何别人的数据，也看不到工作台。给客户用之前建议：改掉默认管理员密码、关掉注册、加 HTTPS（见 DEPLOY.md）。

---

## 5. API（都走同源 Cookie 会话 `pl_sid`）

```
GET  /api/bootstrap                 初始化状态 / 当前用户 / 设置 / 队列快照
POST /api/setup                     首次创建管理员 {email,password}
POST /api/login  /api/logout        登录、退出
GET  /api/me

GET|POST        /api/accounts       列表、新建 {label,provider,cookie}
PATCH|DELETE    /api/accounts/:id   改名/换 Cookie、删除
POST            /api/accounts/:id/check        检测会话

GET|POST        /api/plans          列表、新建 {account_id,name,speed,concurrency,interval_ms,window_start,window_end}
PATCH|DELETE    /api/plans/:id
POST            /api/plans/:id/sync            同步课程目录 → 任务
POST            /api/plans/:id/clear           清空未完成任务

GET  /api/tasks?status=&account_id=&plan_id=&q=     任务列表
POST /api/tasks/:id/retry | /api/tasks/:id/skip
POST /api/tasks/retry-failed
GET  /api/records?limit=            执行记录
GET  /api/stats                     概览统计
GET|POST /api/settings              读取 / 保存设置
POST /api/queue/pause               {paused:true|false}

POST /api/client/signup             客户注册
GET|POST /api/client/orders         客户自己的订单 / 提交 {label,cookie,speed,note,title}
GET  /api/orders                    （管理员）全部订单
PATCH /api/orders/:id               {status:'active'|'closed'|'pending'}
```

---

## 6. 数据与备份

```
data/plugglearn.db        全部数据（SQLite，WAL 模式）
data/plugglearn.db-wal     运行中可能有，停机后合并
```

备份：停服务 → 拷 `data/` 目录 → 启动。或者运行中直接 `sqlite3 data/plugglearn.db ".backup data/backup.db"`。

删除库文件会回到「未初始化」状态，需要重新创建管理员。

---

## 7. 目录结构

```
plugglearn/
├── server.js                HTTP 服务 + 全部路由（约 700 行）
├── lib/
│   ├── db.js                node:sqlite 封装、建表、轻量迁移
│   ├── auth.js              scrypt 密码、会话 Cookie
│   ├── queue.js             调度器（并发 / 时段 / 退避重试）
│   └── providers/
│       ├── index.js         注册表
│       ├── sim.js           模拟环境（不联网）
│       └── chaoxing.js      学习通适配层
├── public/
│   ├── index.html           管理台外壳
│   ├── admin.js             管理台逻辑（hash 路由 + 轮询）
│   ├── app.css              样式（浅色 Apple Music 风格）
│   ├── app.html             客户前台
│   └── favicon.svg          红底插头
├── data/                    数据库（自动创建）
├── shots/                   界面截图
├── DEPLOY.md                局域网 / 手机 / 服务器 / HTTPS 部署
└── start.cmd / start.sh     一键启动
```

---

## 8. 排错

| 现象 | 处理 |
| --- | --- |
| 启动报 `Cannot find module 'node:sqlite'` | Node 版本 < 22.5，升级 Node |
| 页面能开但一直转圈 | 看终端有没有报错；`/api/bootstrap` 是否 200 |
| 改了 CSS 不生效 | 已设 `Cache-Control: no-cache`，强刷一次 Ctrl+Shift+R |
| 任务一直 `等待` | 检查计划是否启用、当前时间是否在时段窗口内、设置里调度是否被暂停 |
| 任务全 `失败` | 账号 Cookie 过期或课程结构变了；重取 Cookie 后「重试失败」 |
| 端口被占用 | `PORT=8710` 换个端口，或杀掉占用进程 `netstat -ano | findstr 8710` |

## 扫码登录与自动做题

- 账号页右上「扫码登录」：服务端向学习通要二维码，手机学习通 App 扫一下，确认后自动建账号（不需要手动复制 Cookie）。
- 提供方三个选项：
  | 提供方 | 说明 |
  | --- | --- |
  | 学习通 · 浏览器路线 | 无头 Edge 打开真实页面，能自动播放 + **自动答题**（题库命中就点选项） |
  | 学习通 · 接口路线 | 纯 HTTP 刷视频进度，轻量但答不了题，超星改版容易失效 |
  | 模拟环境 | 不联网，跑流程用 |
- 题库：`/api/quiz`，缺题自动记录在 `quiz_misses`，补一次答案就进库。
- **自动过验证**：被超星 9010 风控拦到图片验证码时，先查本地字形库（每次成功都回流样本），再用外部 OCR（自带 `tools/ocr_server.py`，包 ddddocr），都不行才登记人工输入。开关与次数在「设置 → 反爬验证」。
- 细节见 [docs/QUIZ.md](docs/QUIZ.md)（扫码链路）与 [docs/BROWSER.md](docs/BROWSER.md)（浏览器路线、选择器、第 12 节讲验证码）。

## 手机端

工作台与客户前台都是响应式的，`public/app.css` 末尾的 `@media (max-width: 720px)` 负责移动端：

- 侧栏变成顶部工具条：品牌 + 「暂停调度 / 退出登录」，导航是可换行的胶囊行（概览 / 账号 / 计划 / 任务 / 记录 / 订单 / 设置）。
- 表格整体切换成卡片模式：隐藏表头，每行一张卡，字段用 `data-label` 当左侧小标签（所以新增表格列时记得给 `<td>` 加 `data-label="列名"`）。
- 记录时间线改成两行：第一行「时间 + 级别」，第二行正文整行铺开。
- 弹窗贴底弹出（底部胶囊按钮、安全区 padding），扫码登录二维码缩到 206px。
- 触控尺寸：主要按钮 ≥38px 高，表格里的 tiny 按钮保持 32px 便于连点。

手机验收截图：`shots/ecs-m-overview.png`、`ecs-m-tasks.png`、`ecs-m-accounts.png`、`ecs-m-plans.png`、`ecs-m-records.png`（390×844 @3x）。
