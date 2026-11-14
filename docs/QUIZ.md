# 扫码登录 + 自动做题：能到哪一步

结论先说：

| 能力 | 能不能做 | 现状 |
| --- | --- | --- |
| 扫码登录学习通（服务端出码，手机扫） | **能，纯 HTTP 就行** | 已实现并跑通到「等待扫码」态，接口 `POST /api/accounts/qr/start` |
| 题库检索（题干 → 答案） | **能** | 已实现：`lib/quiz.js`，精确 + Dice 模糊匹配，带缺题回收 |
| 视频内嵌弹题自动作答 | 能，但要做签名/态移植 | 骨架留了 `submitAnswer` 位置，见下文「路线 C」 |
| 章节测验自动作答 | 能，但更脆 | 同上 |
| 直接「调用 OCS 网课助手」 | **不能**——它是浏览器脚本 | 见下文三条路线 |

---

## 1. 扫码登录：已实测通过

链路（Node fetch 直连，无需浏览器）：

```
GET  https://passport2.chaoxing.com/login?fid=&newversion=true&refer=http%3A%2F%2Fi.chaoxing.com
     → HTML 里 <input value="<32位uuid>" id="uuid"> 和 id="enc"
     → Set-Cookie: JSESSIONID / route（必须留着，和 uuid 配对）
GET  https://passport2.chaoxing.com/createqr?uuid=<uuid>&fid=-1        → 270×270 jpeg 二维码
POST https://passport2.chaoxing.com/getauthstatus/v2
     body: enc, uuid, doubleFactorLogin=0, forbidotherlogin=0
```

返回态：

| 返回 | 含义 |
| --- | --- |
| `{"status":false,"type":"3","mes":"未登录"}` | 等待扫码 |
| `{"status":false,"type":"4","nickname":"xx","uid":"123"}` | 已扫码，等手机端点确认 |
| `{"status":true}` | 登录成功，同一 cookie jar 已有会话 |
| `{"status":false,"type":"2"}` | 二维码失效（**uuid 和 jar 不配对时也会走到这里**） |
| `{"type":"6"}` | 手机上取消 |
| `containTwoFactorLogin:true` | 开了双因子，得走 `twoFactorLoginPCUrl` |

成功后再 GET `https://i.chaoxing.com/base` 与 `https://mooc1.chaoxing.com/visit/interaction`，把 `_uid` / `_d` / `UID` / `vc3` / `fid` 换出来，拼成 accounts 表要的 Cookie 串。

前端接法（还没做 UI）：

```js
const { uuid, image } = await (await fetch('/api/accounts/qr/start', { method: 'POST' })).json();
img.src = image;                                   // 直接显示二维码
const t = setInterval(async () => {
  const s = await (await fetch('/api/accounts/qr/' + uuid)).json();
  if (s.state === 'scanned') hint.textContent = '已扫码，请在手机上确认（' + s.nickname + '）';
  if (s.state === 'ok') { clearInterval(t); await fetch('/api/accounts', { method:'POST', ... cookie: s.cookie }); }
  if (s.state === 'expired' || s.state === 'cancelled') { clearInterval(t); refreshQr(); }
}, 2000);
```

---

## 2. OCS 网课助手到底是什么

它是**跑在浏览器页面里的用户脚本/扩展**，三件事：

1. 在页面 DOM 里找播放器、点播放、拖进度、切下一节；
2. 抓到题目文本 → **问题库**（本地库或第三方题库 API）→ 拿答案 → 点选项、填输入框、点提交；
3. 定时上报进度接口。

关键点：**它的强项是"在页面里点"，它的题库对服务端是可复用的，但它的点击逻辑搬不走。** 学习通的答题请求里带 `enc`、`_t`、随机 nonce 这些由页面 JS 现算的参数，纯 HTTP 复刻要连带把那段混淆 JS 一起移植。

所以只有三条路：

### 路线 A：OCS 留在浏览器，plugglearn 只管账号和进度（0 改造，最省事）

- 手机扫码在 plugglearn 里做 → 拿 Cookie → 在**装了 OCS 的浏览器**里用同一账号登录 → OCS 自己刷、自己答。
- plugglearn 的价值退化成：账号池、Cookie 保鲜、进度看板、客户前台。
- 缺点：还是要开着那台带脚本的浏览器；弹题靠它；多账号要多个浏览器上下文。

### 路线 B：无头 Edge + CDP 注入 OCS（推荐，工程上最划算）

- 用本机已装的 Edge：`msedge --headless=new --remote-debugging-port=9222 --user-data-dir=<每个账号一个>`；
- plugglearn 用 WebSocket 连 CDP，`Page.navigate` 打开章节 → `Runtime.evaluate` 注入 OCS 脚本或直接操作 DOM；
- 扫码登录出来的 Cookie 通过 `Network.setCookie` 灌进这个浏览器实例，登录态就有了；
- 答题、点播放、切章节全交给脚本，进度用 `Runtime.evaluate` 读回来写进 tasks 表。
- 代价：每个并发账号一个浏览器进程（内存 ~150MB/个），并发要压到 2~3。

### 路线 C：纯 HTTP 复刻（最脆，但最轻）

- 题库这半已经做好了（`lib/quiz.js`）；
- 难的半：答题提交。

  视频弹题：章节页 `mooc1.chaoxing.com/mooc-ans/knowledge/cards?...` 返回的 attachment 里带 `question`，提交时按抓包里那一发 POST 打过去，通常带 `answer`、`answertype`、`enc`、`_t`；
  章节测验：`mooc1.chaoxing.com/mooc-ans/work/...`，交卷接口是 `addStudentWorkNew`，参数里同样有 `enc`。

  实操建议：先在装了 OCS 的浏览器里，对着一次答题用 F12 的 Copy as cURL 抓两发请求（一发弹题、一发测验），把 URL 和参数名照着填进 `chaoxing.js` 的 `submitAnswer()`——比照源码猜快得多。

---

## 3. 已经落地的部分

```
lib/providers/chaoxing-login.js   startQr / pollQr / finish / drop
lib/quiz.js                       normalize / dice / find / learn / importMany / miss / toAnswerParam
```

新接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/accounts/qr/start` | 出二维码，返回 `{uuid, image:dataURL}` |
| GET | `/api/accounts/qr/:uuid` | 轮询 `{state: waiting\|scanned\|ok\|expired\|cancelled\|twofactor}`，`ok` 时带 `cookie` |
| POST | `/api/accounts/qr/:uuid/close` | 丢弃这个二维码会话 |
| POST | `/api/quiz/lookup` | `{question, options}` → 命中返回 `{answer, param}`，未命中记一条缺题 |
| POST | `/api/quiz` | 录题 `{question, type, options, answer}` |
| POST | `/api/quiz/import` | 批量 `{items:[...]}` |
| GET | `/api/quiz` | 浏览题库 + 统计（总数/命中/按题型/待补） |
| DELETE | `/api/quiz/:id` | 删题 |
| GET | `/api/quiz/misses` | 待补的缺题列表 |
| POST | `/api/quiz/misses/:id/resolve` | 补答案，自动写回题库 |

实测（本机 8710）：

```
POST /api/accounts/qr/start  → uuid=281f244af4534c57b0f0c392ee858810, image 1395B（真二维码）
GET  /api/accounts/qr/<uuid> → {"state":"waiting","note":"未登录"}
POST /api/quiz/lookup  (未收录) → {"hit":false,"miss_id":1}
POST /api/quiz         (录 D)   → {"id":1}
POST /api/quiz/lookup  (同题)   → {"hit":true,"score":1,"param":"D"}
POST /api/quiz/lookup  (多选题) → {"hit":true,"param":"A,C,D"}
```

---

## 4. 题库怎么和 OCS 共用

OCS 的题库接口是可配置的 HTTP 接口，一般要 `POST {question, options, type}`、回 `{answer}`。想让 plugglearn 当它的题库源，加一层适配就行（还没写，因为要先确认你用的那版 OCS 的请求格式）：

```js
router.post('/api/quiz/ocs', (req, res) => {
  const { question, options } = req.body;        // OCS 发过来的字段名按它的脚本改
  const hit = quiz.find(question);
  res.json(hit ? { code: 1, data: { answer: hit.answer } } : { code: 0 });
});
```

反向也行：把 OCS 落库的题导进来 —— `POST /api/quiz/import`，`items` 里一条 `{question, answer, type, options}`。

---

## 5. 我建议的推进顺序

1. **先把扫码登录接到界面上**（半天）：账号页加「扫码登录」按钮 → 弹二维码 → 扫完自动建账号。这一步没有任何不确定性，接口已经跑通。
2. **补题库**（持续）：先用 `/api/quiz/misses` 收题，答题时人工补几个，命中率很快能到 80%+。
3. **再决定答题路线**：只想自己用 → 路线 A 够；要给客户用、要无人值守 → 路线 B（无头 Edge + OCS 注入），这是唯一能稳定吃下弹题的做法。
4. 路线 C 只在「服务器没有 GUI、必须纯 HTTP」时才值得啃 `enc`。
---

## 远程题库（第三方题库接口）

设置页 → **远程题库**，把 OCS / 网课助手那种配置数组整段粘进去，点「导入配置」，开关打开即可。

```json
[{"name":"言溪题库","url":"https://tk.enncy.cn/query","method":"post",
  "headers":{"Content-Type":"application/json"},
  "data":{"token":"xxx","title":"${title}","options":"${options}","type":"${type}"}}]
```

我们只取 `url / method / headers / data`，把 `${title} ${options} ${type}` 换成真实值（`images` 那种函数钩子会被丢掉）；`handler` 字段不执行（不 eval 用户脚本），答案从响应里直接挖。

### 言溪返回长什么样（实测）

```json
{"code":1,"data":{"question":"中国共产党人的初心和使命是","answer":"为中国人民谋幸福为中华民族谋复兴","times":1582,"ai":true},"message":"请求成功"}
```

两个坑：

1. **`code` 不是 0 也算成功**：`code:0` 是题库命中，`code:1` 是 AI 兜底（`data.ai:true`），两者都有 `data.answer`。旧版按 `code===0` 判断会把 AI 答案当失败。
2. **`answer` 是选项文字，不是字母**：`lib/quiz.js` 的 `answerToParam()` 负责换算——先认 `A`，再按文本精确/包含匹配，最后 Dice ≥ 0.6 模糊兜底；多选题言溪用 `#` 拼接（`社会存在决定社会意识#人民群众是历史创造者` → `A,B,D`）。

### 实测结果

| 题型 | 题库返回 | 换算 | 入库 |
| --- | --- | --- | --- |
| 单选 | `为中国人民谋幸福为中华民族谋复兴` | `A` | ✓ 第二次本地命中 `score:1` |
| 多选 | `社会存在决定社会意识#人民群众是历史创造者#生产力决定生产关系` | `A,B,D` | ✓ |
| 判断 | `正确` | `A`（有选项字母时给字母，而非 true/false） | ✓ |

命中后会写进 `quiz_bank`（`source=题库名`），下次 0 网络延迟秒中；没答出来的仍进 `quiz_misses`。

接口：`GET /api/quiz/remote`（token 打码）、`POST /api/quiz/remote`（`{config}` 导入 / `{enabled}` 开关）、`POST /api/quiz/remote/test`（带 question/options/type，默认一条示例题）。
