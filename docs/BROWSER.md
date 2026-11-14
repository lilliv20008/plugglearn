# 路线 B：无头 Edge + CDP 自动做题

零依赖实现：Node 自带的 `WebSocket` 直接说 CDP 协议，不装 Puppeteer。

```
lib/browser.js                  启动 Edge / CDP 客户端 / Cookie 注入 / evaluate
lib/providers/chaoxing-browser.js  学习通的「浏览器路线」提供方
lib/quiz.js                     题库（题干归一化 + 模糊匹配）
```

## 1. 它是怎么跑的

```
queue.js 取到任务
   ↓
provider = chaoxing-browser
   ↓  一个账号一个浏览器（user-data-dir = data/browsers/<账号ID>，登录态落盘可复用）
msedge --headless=new --remote-debugging-port=<随机> --user-agent=<非 Headless UA>
   ↓  Network.setCookie 把账号里的 Cookie 灌进去
Page.navigate 打开 chapterId 对应的 studentstudy 页
   ↓  1.5s 一轮的控制环
Runtime.evaluate 读页面：<video> 时间、有没有弹题、题干与选项
   ↓
有题 → quiz.find(题干) → 命中就 evaluate 点选项 + 点提交；没命中记进 quiz_misses
有视频 → v.play()、v.playbackRate=plan.speed，播完且静默 3 轮算过
都没有 → 看正文有没有「已完成」，否则等 8 轮退出
```

要点：**登录态、enc 签名、随机题都由页面自己算**，我们只做「读 DOM + 点按钮」，所以超星改接口不影响，改 DOM 才影响——比纯 HTTP 路线抗改。

## 1.5 章节是怎么发现的（2026-11 实测，别再用老 URL）

老写法 `mooc1.chaoxing.com/mycourse/studentcourse?courseId=..&clazzid=..&ut=s` 现在会**重定向到学校门户**
（实测：`i.mooc.chaoxing.com/space/index.shtml?burl=passport2.chaoxing.com/mooc.jsp`），HTML 里一个
`chapterId` 都没有 —— 这就是「同步失败：没有解析到章节」的真正原因，不是课程没开。

现在走的是**新版课程门户（mooc2）三级结构**：

```
① 课程卡：https://mooc1-1.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=<cid>&clazzid=<clz>&vc=1&ismooc2=1&v=2
      ↓ 302
② 门户页：https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=..&clazzid=..&cpi=..&enc=..&pageHeader=1&v=2
      ↓ 里面一个 iframe
③ 章节树：https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?courseid=..&clazzid=..&cpi=..&ut=s&stuenc=..
```

在 ③ 里：

- 每个章节是 `div.chapter_item[id^="cur"]`，`id` 去掉 `cur` 就是 **knowledgeId**；
- `onclick="toOld('<courseid>','<knowledgeId>','<clazzid>',0)"` 给出三个 ID；
- `title` 属性是章节名；
- `div.catalog_state.icon_yiwanc` 存在 = **该章节已完成**（悬浮提示「已完成」）；
- `window.toOld` 的源码里藏着 `var enc = "<32位hex>"` 和 `var cpi = <数字>` —— 学习页要用。

学习页（④）由这三者拼出来：

```
https://mooc1.chaoxing.com/mycourse/studentstudy
  ?chapterId=<knowledgeId>&courseId=<cid>&clazzid=<clz>&cpi=<cpi>&enc=<enc>
  &mooc2=1&hidetype=0&fanyaVersion=0
```

页面里视频藏在**第三层** iframe：

```
studentstudy（主文档）
  └─ iframe mooc1.chaoxing.com/mooc-ans/knowledge/cards?...   ← 任务点容器
       └─ iframe mooc1.chaoxing.com/ananas/modules/video/index.html   ← 真正的 <video>
```

所以探针 `walk()` 必须递归到 3 层，只扫主文档永远看不到 video。

两个必须记住的坑：

1. **`<video>.duration` 常常是 `null`**（分片流，metadata 要等缓冲才有）。第一版拿 `t >= d - 1.2`
   当完成判据，`null` 一参与比较就永远为假 → 任务卡死不动。现在 `d` 不可用时改用「时间不前进 20 拍」判结束。
2. **播放器会自己把 `playbackRate` 改回 1**。只 `v.playbackRate = rate` 顶不住，实测仍是 1x。
   解法是给每个 `<video>` 装一个只认目标倍速的 setter（`Object.defineProperty(v,'playbackRate',{set(){desc.set.call(this,RATE)}})`），
   再用 700ms 定时器重新遍历 iframe 兜底。实测 `rate=3` 时 `currentTime` 15 秒走 45 秒，倍速真的生效。

另外：进程被强杀时数据库里 `status='running'` 的行会永远卡住，`queue.start()` 启动时会自动回收成 `pending`。

## 2. 怎么开

1. 账号页 → 添加账号 → 提供方选 **「学习通 · 浏览器路线（能自动答题）」**；
2. Cookie 用扫码登录拿（页面右上「扫码登录」），或手动粘贴；
3. 计划照常建，`speed` 就是播放倍速（1–4），`interval_ms` 是控制环间隔（默认 1500）；
4. 账号行上点 **「看页面」** 可以随时看无头浏览器现在看到什么（用来判断选择器/登录态对不对）。

## 3. 探针输出

`POST /api/accounts/:id/probe`，body 可带 `{"url": "..."}` 让浏览器先跳过去再看：

```json
{
  "url": "https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=...",
  "title": "...",
  "video": { "paused": true, "ended": false, "t": 0, "d": 632.4, "rate": 1 },
  "quiz": { "text": "1.（单选题）……", "options": ["A 哲学", "B ..."], "answered": false },
  "roots": 2,
  "port": 9893
}
```

`roots` 是扫过的文档数（主文档 + 同源 iframe）。`quiz` 为 `null` 说明当前没有可识别题目。

## 4. 选择器在哪改

都在 `lib/providers/chaoxing-browser.js`：

```js
const QSEL = ['.ans-videoquiz', '.videoquiz', '#videoquiz', '.TiMu', '.questionLi', '.ans-videoquiz-wrap'];
const OPT  = 'li, .ans-videoquiz-opt, .option, label';
```

超星改版时，先用「看页面」确认题干容器还在不在，把新 class 加进 `QSEL` 即可，其余逻辑不用动。

## 5. 答对率怎么提

- 弹题没人答过的会进 `quiz_misses`（`GET /api/quiz/misses`）；
- 人工补一次答案（`POST /api/quiz/misses/:id/resolve`）就自动进题库，下次命中；
- 匹配是「归一化 + Dice 二元组 ≥ 0.86」，标点、空格、全半角差异都能吃下；题干被截断也能中，但差值太大（长度差 > 45%）会跳过，避免误答。

## 6. 并发与资源

- 一个浏览器进程约 120–180MB；2 vCPU / 2G 的机器上**并发 1–2**，别设 6；
- 会话空闲 3 分钟自动关闭（`IDLE_MS`），下次任务重新拉起；
- `data/browsers/<账号ID>` 存的是登录态，删掉等于退出登录；
- Cookie 失效时任务会明确报「页面跳到了登录页」，重新扫码即可。

## 7. 已经验证过的部分

```
Browser.launch                   ✓ 792ms 起来
Page.navigate 真实站点           ✓ https://www.chaoxing.com/ → title 超星
未登录跳转检测                   ✓ mooc1 → passport2.chaoxing.com/login?refer=...
cookie 注入 + Network.setCookie  ✓
Runtime.evaluate 往返           ✓
账号 check（浏览器路线）         ✓ 正确报「Cookie 失效，页面跳到了登录页」
probe（可带 url）                ✓ 返回 video/quiz/roots/port
```

还没在真实已登录课程上跑过整章——需要你自己的学习通账号扫一次码，第一跑的日志会明确写出「答题（精确）→ D」或「题库没有这道题（缺题 #1）」，照着补就行。
## 8. 服务器上起不来？多半是「session 0」的锅

Windows 服务器把后台服务丢在 **session 0**（没有交互桌面），这时：

- **Microsoft Edge 一定起不来**：进程秒退，`Browser.launch()` 报 `浏览器进程已退出（code 1002）`，`--no-sandbox` 也没用；
- **Chrome 可以**，但必须关沙箱，否则 stderr 里是
  `Sandbox cannot access executable ...: 拒绝访问。(0x5)`，随后 `Network service crashed`。

所以部署到服务器时要按这套来：

1. 把 Chrome for Testing 解压到 `C:\plugglearn\chrome\chrome-win64\chrome.exe`
   （`https://cdn.npmmirror.com/binaries/chrome-for-testing/157.0.8103.78/win64/chrome-win64.zip`）；
2. `lib/browser.js` 的 `findBrowser()` 会优先用这个目录，其次 `BROWSER_PATH` 环境变量，最后才找 Edge；
3. `Browser.launch()` 现在默认带 `--no-sandbox`（想打开沙箱设 `BROWSER_SANDBOX=1`）；
4. 计划任务直接跑 node，别再用 `cmd /c start.cmd`（cmd 退出会让 node 变成孤儿进程被回收）：

```powershell
$arg = '-NoProfile -WindowStyle Hidden -Command "$env:PORT=''8710''; Set-Location C:\plugglearn; & .\node\node.exe --no-warnings server.js *>> C:\plugglearn\server.log"'
$act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory 'C:\plugglearn'
$st  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'plugglearn' -Action $act -Settings $st -User 'SYSTEM' -RunLevel Highest -Force
```

5. `data\browsers` 要给 SYSTEM 完全控制：`icacls C:\plugglearn\data\browsers /grant "SYSTEM:(OI)(CI)F" /T`。

实测（一台 ECS，2C2G）：Chrome 起来约 5–9 秒（比本机慢，因为要初始化 profile），
`POST /api/accounts/1/check` 3–9 秒返回「浏览器已就绪 · 课程 · 3 门课程」，
`POST /api/plans/1/sync` 26 秒解析 501 个章节。

## 9. 倍速：为什么必须用 CDP 注入

学习通的播放器有两条「反倍速」机制：

1. 它会在 `<video>` **实例**上定义一个 `playbackRate` 访问器，把值钉在 1；
2. 它每次换视频（同一章里的多个视频点）都会**重新加载页面**。

所以：

- 只在页面里调一次 `v.playbackRate = 2` 无效（下次写回 1）；
- 在页面里 `setInterval` 也没用（页面一重载，定时器全没了）；
- 正解是 CDP 的 `Page.addScriptToEvaluateOnNewDocument`：脚本会在**每个新文档（含 iframe）**里先跑一遍。

实现见 `lib/browser.js` 的 `initScript()` 和 `lib/providers/chaoxing-browser.js` 的 `RATE_GUARD`：

```js
// 每个文档里跑：先删站点塞的实例属性，再走 HTMLMediaElement.prototype 上的真 setter
const dd = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
delete v.playbackRate;          // 只在第一次见到这个元素时删，别每秒 delete
dd.set.call(v, R);              // 走原型 setter，值才真的生效
```

实测（ECS，`speed=1.5`）：`t` 从 197s 走到 386s 用了 126 秒墙钟 → **1.5x 真实生效**。

## 10. 别把倍速拉太高：9010 反爬

`rate=3` + 每 250ms 强刷倍速，会让学习通把账号踢到

```
https://mooc1.chaoxing.com/antispiderShowVerify.ac
【9010】操作异常，请输入图片中的验证码
```

这是个 4 位图片验证码（`/processVerifyPng.ac?t=...` → 表单 GET `/html/processVerify.ac?app=0&ucode=XXXX`）。
处理方式：

- 代码里已经识别这个页面，抛 `超星要求人工验证（反爬验证页）`，并把**整个队列自动暂停**，不会一路烧任务；
- 解验证码最快的是把这个 URL 在**自己的手机/浏览器**里打开过一次（同一账号）；
- 现在线上跑的是 `speed=1.5`、`interval_ms=8000`，配合上面的「1.5 秒才纠正一次」策略，没有再触发。

## 11. 页面没加载出来 ≠ 已完成

早期版本在「没有 video 元素」时会计入 `idleTicks`，6 拍后当成功处理，结果被风控页骗了 11 个任务记为 done。
现在只要 `roots <= 2`（页面基本是空的）就直接报「学习页没加载出来」，同样会暂停队列，不再假完成。

## 12. 自动过验证（9010 图片验证码）

被踢到 `antispiderShowVerify.ac` 时不再直接停下来等人，而是按三层顺序自己过：

| 顺序 | 方式 | 说明 |
| --- | --- | --- |
| 1 | 本地字形库 `lib/captcha-bank.js` | 把一个字符切成 16×20 二值格子做特征，汉明距离最近邻；每次成功（自动或人工）都会把这 4 个字符入库，用得越久越准 |
| 2 | 外部 OCR（`lib/captcha.js` 的 `queryRemote`） | 可配任意 HTTP 服务，默认给 `tools/ocr_server.py`（包 ddddocr），本机实测 12/14 正确 |
| 3 | 人工兜底 | 走不通就登记到「设置 → 反爬验证」的待输入列表，填一次=给库加 4 个样本 |

- 切图：按 `img` 的 src 命中 `processVerifyPng`，找不到就挑「宽 80–400、高 20–140、宽高比 ≥1.8」的小图；canvas 读像素 → Otsu 二值化 → 3×3 去噪 → 列投影切 4 段。
- 提交：`GET /html/processVerify.ac?app=0&ucode=XXXX`，回读 URL 仍命中验证页就算错，最多 `max_tries`（默认 5）次。
- 开关与次数在设置页，接口是 `GET/POST /api/captcha`、`POST /api/captcha/test`、`POST /api/accounts/:id/captcha`（手动点「过验证」）、`POST /api/captcha/resolve`（人工输入）。
- 起 OCR 服务：`pip install ddddocr` 后 `python tools/ocr_server.py 8899`，`GET /health` 回 `{"ok":true,"engine":"ddddocr"}`；服务器上已注册成开机任务 `plugglearn-ocr`（SYSTEM）。
- 只有这一层也过不去（比如账号已被要求短信验证）才会照旧抛「超星要求人工验证」，队列自动暂停。
