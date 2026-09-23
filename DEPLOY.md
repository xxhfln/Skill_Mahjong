# 部署到公网 · 详细步骤

本项目的房间模式需要一个 **WebSocket 后端**。纯静态托管（Netlify / GitHub Pages / 对象存储）
只能放页面，**放不了房间服务**——所以公网部署一定是「静态页面 + 一台能跑 Node 的机器」的组合。

---

## 三条路线，先选一条

| 路线 | 做法 | 费用 | 适合谁 | 主要缺点 |
| --- | --- | --- | --- | --- |
| **A · Render 一条龙**（推荐起步） | 整个仓库部署到 Render，**页面和后端一起**由 Node 托管 | 免费额度 | 想最快上线、不想配置 | 免费版空闲 15 分钟休眠，唤醒约 1 分钟 |
| **B · Netlify 前端 + Render 后端** | 页面走 CDN，后端独立 | 免费额度 | 页面要固定域名、加载快 | 要手填一行后端地址 |
| **C · Cloudflare Tunnel** | 本机跑服务，隧道映射到公网 | $0 | 临时异地聚会，今天晚上就要玩 | 电脑必须开机，免费版网址每次重启都变 |

> 如果你在国内且对稳定性要求高，可选付费路线：腾讯云轻量 / Zeabur / 阿里云 ECS，
> 仓库里已备好 `Dockerfile`，任意支持 Docker 的平台都能跑。

---

## 0. 准备工作（三条路都要做）

Render 从 GitHub 拉代码部署，所以必须先把当前改动推上去。**你现在的工作区有大量未提交改动**
（含本次修复的 `/ws` 握手路径、新增的 `js/config.js`、`Dockerfile` 等），不推送等于部署旧版本。

在项目根目录执行：

```bash
git add -A
git commit -m "feat: 房间模式 + 公网部署配置"
git push Skill_Mahjong main
```

确认推送成功：

```bash
git status   # 应显示 nothing to commit, working tree clean
```

> 注意：`.gitignore` 里有 `docs/` 和 `*.zip`，这两个不会被推送，**不影响部署**。

---

## 路线 A · Render 一条龙（推荐）

**为什么推荐**：`server/index.js` 本身就能托管静态页面，并会把访问地址自动注入前端，
所以这条路**不需要任何地址配置**，部署完打开就能建房。

### 第 1 步：注册 Render

打开 <https://render.com> → 点右上角 **Get Started** → 选 **Sign in with GitHub**
（用 GitHub 登录最省事，后面授权读仓库一步到位）。

### 第 2 步：新建 Web Service

Dashboard 右上角 **New +** → **Web Service**。

如果是第一次用，先点 **Connect account / Configure account**，授权 Render 访问仓库：
选 **Only select repositories** → 勾 `xxhfln/Skill_Mahjong` → Install。

回到 New Web Service 页面，应该能看到这个仓库出现在列表里，点 **Connect**。

### 第 3 步：填配置

| 字段 | 填什么 | 说明 |
| --- | --- | --- |
| Name | `skill-mahjong` | 会变成网址的一部分，字母/数字/短横线 |
| Region | **Singapore** | 离国内较近；备选 Frankfurt / Oregon |
| Branch | `main` | 和你推送的分支一致 |
| Runtime | **Node** | 自动识别 `package.json` |
| Build Command | 留空 | 没有构建步骤，Render 默认执行 `npm install` |
| Start Command | `npm start` | 等价于 `node server/index.js` |
| Instance Type | **Free** | 先用免费档验证 |

**不需要**设置任何环境变量（`PORT` 平台会自己给，代码已读取 `process.env.PORT`；
服务也已绑定 `0.0.0.0`，这是云平台的硬性要求）。

点 **Create Web Service**。

### 第 4 步：等部署完成

初次构建约 1–3 分钟。日志里看到

```
==> Running 'npm start'
...
Your service is live 🎉
```

即成功。页面顶部会显示你的网址，形如：

```
https://skill-mahjong-xxxx.onrender.com
```

### 第 5 步：验证

浏览器打开这个网址 → 切到「房间」标签 → 填昵称 → 创建房间，应该立刻进房并显示房间码。
右上角连接状态显示「已连接」。

命令行深度验证（建房 / 加入 / 抽牌 / 保密 / 使用公开全链路）：

```bash
BASE_URL=https://skill-mahjong-xxxx.onrender.com npm run smoke
```

全部 ✅ 就说明公网可用。

> **懒人版**：仓库里已经放好了 `render.yaml`（Blueprint）。
> Render 里 **New + → Blueprint → 选本仓库**，上面第 3 步的配置会自动套好，只需等待部署。

---

## 路线 B · Netlify 前端 + Render 后端

这条路多一步：**静态页面不知道后端在哪**，`js/config.js` 就是解这个的。

### 第 1 步：先按「路线 A」把后端跑起来

拿到后端网址，例如 `https://skill-mahjong-xxxx.onrender.com`。
（此步完成后，Render 这个地址本身已经能玩了；继续做 B 是为了让页面走 CDN、更快更稳。）

### 第 2 步：填后端地址

打开 `js/config.js`，把最后一行改成：

```js
window.MJ_PUBLIC_WS_URL = "wss://skill-mahjong-xxxx.onrender.com/ws";
```

**两个必须注意的点**：

1. 必须是 **`wss://`**（不是 `ws://`）。页面是 https 时，浏览器会直接拒绝明文 WebSocket。
2. 结尾的 **`/ws` 不能少**。服务端只接管 `/ws` 路径，缺路径的握手会被拒（400），
   表现就是「网页打得开，但点创建房间毫无反应」——本机那个 bug 就是这么来的。

### 第 3 步：改资源版本号（不改等于白改）

浏览器会缓存 JS。打开 `index.html`，把里面所有 `?v=20260924a` 统一加到一位，例如 `?v=20260924b`：

```html
<link rel="stylesheet" href="css/style.css?v=20260924b" />
<script src="js/config.js?v=20260924b"></script>
<script src="js/skills.js?v=20260924b"></script>
<script src="js/app.js?v=20260924b"></script>
<script src="js/rooms.js?v=20260924b"></script>
```

`css/`、`js/` 目录里的旧文件不用动，版本号变了就是新 URL。

### 第 4 步：部署前端，二选一

**4a. Git 连接（推荐，以后推送即自动部署）**

Netlify → **Add new site** → **Import an existing project** → GitHub → 选本仓库。
构建设置留默认（`netlify.toml` 已写好 publish 目录 `.` 、无构建命令）→ **Deploy**。

> 记得先 `git commit && git push`，否则 Netlify 拉到的还是第 2 步之前的版本。

**4b. 拖拽上传（不用 Git）**

双击项目根目录的 `build-zip.bat`，它会重新生成 `skill-mahjong-netlify.zip`
（已包含 `index.html`、`netlify.toml`、`css/`、`js/`、`assets/`，且**不含后端代码**）。
然后把这个 zip 拖到 <https://app.netlify.com/drop>。

### 第 5 步：验证

打开 Netlify 给的 `https://xxx.netlify.app` → 房间标签 → 直接建房。
**大厅里的「服务器地址」输入框留空即可**——前端会自动从 `js/config.js` 读取后端地址。

如果连不上，打开浏览器开发者工具 → Console，看 WS 地址解析成了什么；
或临时在输入框手填 `wss://.../ws` 排除网络问题。

---

## 路线 C · Cloudflare Tunnel（今晚就要异地开一局）

不需要买服务器、不需要有公网 IP、不需要路由器端口映射。代价：**你的电脑必须一直开着**。

### 第 1 步：本机启动服务

```bash
npm start        # 监听 http://localhost:3000
```

### 第 2 步：安装 cloudflared

任选其一：

```powershell
winget install Cloudflare.cloudflared
```

或从 <https://github.com/cloudflare/cloudflared/releases> 下载 Windows 版
（`cloudflared-windows-amd64.exe`，改名为 `cloudflared.exe` 丢进任意目录）。

装完后重开一个终端才能让 PATH 生效。

### 第 3 步：起隧道

```bash
cloudflared tunnel --url http://localhost:3000
```

约 3 秒后终端会打印：

```
Your quick Tunnel has been created! Visit it at:
https://random-words-here.trycloudflare.com
```

把这个 https 链接发给朋友即可。Cloudflare 自动提供 TLS，**WebSocket 原生支持**，无需额外配置。

### 这条路的实话

- **网址每次重启都变**。想要固定网址需要在 Cloudflare 挂一个自己的域名做 named tunnel（一次性五分钟配置）。
- 免费 Quick Tunnel 有约 200 并发请求上限，官方定位就是测试/演示，**不适合长期正式使用**。
- 隧道随进程终止，`Ctrl+C` 就下线，没有残留需要清理。
- 你的电脑 = 服务器。关机、断网、休眠都会导致房间消失（房间状态在内存里）。

---

## 部署后：这些限制你必须知道

### 房间数据不持久

房间状态全在 Node 进程内存里。**服务重启 / Render 休眠后再唤醒 = 所有房间清空**，
玩家名单、手牌、局数全部消失（配置本身也一起没了，因为是同一份内存）。

本项目定位就是「聚完即走」的轻量工具，没有做持久化。如果需要重启后仍在，
要额外接数据库——这是另一个量级的工程了。

### Render 免费版的休眠

- 15 分钟没有任何入站流量就休眠，下次访问约需 **1 分钟**唤醒。首次建房前请让朋友耐心等一下。
- 自 2026 年 2 月起，**WebSocket 消息也算活跃流量**。服务端内置了 30 秒心跳，
  只要有人开着房间页面，理论上能持续保活——但不要完全依赖，重要的局建议提前半小时先打开一次。
- 如果你发现它还是睡了，可以用 UptimeRobot（免费）每 10 分钟请求一次 `https://你的域名/health` 保活。
  **不要 ping `/robots.txt`**——Render 在休眠时会自己拦截这个路径返回内容，永远唤不醒。
- 免费额度是 750 实例小时/月（整个 workspace 共享），7×24 小时 ping 保活会直接吃满额度导致暂停。

### 安全边界

- **房间码不是凭证**。任何拿到房间码、且能访问到你服务的人都能进房。
- 如果不想公开，请在前面加一层访问控制（Nginx BASIC 认证 / Cloudflare Access / 只分享给朋友不扩散链接）。
- 本项目**纯属娱乐，禁止用于任何赌博或真实金钱交易场景**。

---

## 排障速查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 网页打得开，点「创建房间」没反应 | WebSocket 没连上 | 看页面右上角连接状态；不是「已连接」就先修地址 |
| 地址看着对，仍然 400 | 缺 `/ws` 路径 | 地址必须以 `/ws` 结尾 |
| Console 报 mixed content | https 页面连了 `ws://` | 必须是 `wss://` |
| 首次打开要等很久 | 免费实例休眠唤醒 | 等约 1 分钟；或先手动访问一次再开始玩 |
| 房间突然空了 | 服务休眠/重启过 | 内存存储，重开一局即可 |
| 手机显示还是旧界面 | 浏览器/微信缓存 | 链接后加 `?t=1`；已做的版本号 bump 只在改过 `?v=` 时生效 |
| 朋友连不上（限局域网） | Windows 防火墙拦 3000 入站 | 走公网路线，或手动放行 TCP 3000 |

手动连通性验证（任何一条路线都适用）：

```bash
curl https://你的域名/health
# 期望返回：{"ok":true,"rooms":0}

BASE_URL=https://你的域名 npm run smoke
# 期望输出全部 ✅
```
