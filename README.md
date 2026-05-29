# feishu-codex-bridge

> 把飞书 / Lark 桥接到你本机的 [Codex](https://github.com/openai/codex)，在群里 @ 机器人就能让 Codex 在指定项目目录里干活，结果以流式 Markdown 卡片实时回到群里。
>
> **项目 = 群 = 固定工作目录（cwd）**，**话题（thread）= 一个 Codex 会话（session）**。

一句话：你在飞书群里发「帮我加个登录接口」，机器人就在这个群绑定的代码目录里跑 Codex，边跑边把推理、命令、改动、结果更新到一张卡片上；点 ⏹ 可随时终止。

```
飞书群消息 ──长连接(WSClient)──▶ bridge ──JSON-RPC/stdio──▶ codex app-server (每会话一进程)
   ▲                                  │
   └──────── 流式 Markdown 卡片 ◀──────┘
```

---

## ✨ 特性

- **群 = 项目**：每个群绑定一个本地目录与默认参数；@ 机器人即在该目录跑 Codex。
- **话题 = 会话**：在群里对某条消息开话题，话题内是一条连续的 Codex 会话（自动 resume）。
- **流式卡片**：推理 / 命令 / 文件改动 / 结果实时刷新到一张可折叠卡片。
- **免 @ 对话**：项目群话题内可直接说话、不必每次 @（可逐群开关）。
- **私聊控制台**：私聊机器人弹交互菜单 —— 新建项目、项目列表、设置、诊断、重连。
- **稳定隔离**：每会话独立 app-server 进程；卡死有 watchdog（默认 120s）→ 终止 → 回收，异常不波及其他群。
- **本地加密密钥库**：飞书应用密钥用 AES-256-GCM 存在 `~/.feishu-codex-bridge/`，不入仓库、不进环境变量。
- **可常驻**：macOS 下可注册成 launchd 后台服务，开机自启。

---

## ⚠️ 安全须知（务必先读）

本机器人调用 Codex 时固定使用 **`approvalPolicy: "never"` + `sandbox: "danger-full-access"`** —— 即 **无任何人工审批、对磁盘完全访问**。这意味着：

> **任何能在项目群里给机器人发消息的人，都能在你这台机器上、以你的身份、在该项目目录里执行任意命令（读写文件、联网、运行脚本）。**

因此：

- 只把**你信任的人**拉进项目群；
- 在**你自己掌控的机器/账号**上运行，最好是隔离的开发机或容器；
- 绑定的项目目录里不要放你不愿被读写的敏感数据；
- 它不是多租户托管服务，是给你（和你信任的小团队）自用的桥。

---

## 📦 前置条件

| 依赖 | 说明 | 获取方式 |
|------|------|----------|
| **Node.js ≥ 20** | 运行时 | <https://nodejs.org> 或 `nvm install 20` |
| **Codex CLI** | 后端，bridge 会 spawn `codex app-server` | `npm i -g @openai/codex`，或安装 Codex.app，或用环境变量 `CODEX_BIN` 指向已有二进制 |
| **Codex 已登录** | app-server 需要 `~/.codex/auth.json` | 运行 `codex login` |
| **飞书 / Lark 账号** | 且该租户允许「扫码创建应用」（个人/开发者租户一般可以；部分企业租户由管理员限制） | 首次 `start` 时扫码即可创建 |

> 不需要单独安装 `lark-cli`：出入站全部走 `@larksuiteoapi/node-sdk` 的长连接。

---

## 🚀 安装与启动

### 1. 安装

```bash
# 推荐：全局安装到稳定路径（后台常驻服务需要稳定的 CLI 路径）
npm i -g @clayz/feishu-codex-bridge

# 或：只想先试一下 / 只为完成首次扫码（免安装，单次运行）
npx -y @clayz/feishu-codex-bridge@latest start
```

> 装好后命令名是 `feishu-codex-bridge`（不带 scope）。
> 也可从源码装：`npm i -g github:modelzen/feishu-codex-bridge`（`prepare` 钩子自动构建）。

### 2. 首次扫码 onboarding（前台跑一次，一次性）

```bash
feishu-codex-bridge start
```

这是**交互式扫码**，需前台跑一次：检查 codex → 扫码自动创建/授权飞书应用（密钥进本地加密库）→ 校验凭据并**打印「一键开通全部权限」链接**（点开一次性开通）→ 起长连接。完成后还要去飞书后台**订阅事件**（见下节），然后 Ctrl-C 退出。

### 3. 转后台常驻（推荐 —— 日常就这么跑）

onboarding 完成后注册成后台服务：**开机自启、崩溃自动拉起、关掉终端也照跑**。

```bash
feishu-codex-bridge service install launchd   # macOS launchd 用户代理
feishu-codex-bridge service status            # 状态 / pid / 上次退出码
feishu-codex-bridge service logs              # 跟踪日志
feishu-codex-bridge service restart
feishu-codex-bridge service uninstall
```

> ⚠️ **后台服务必须用全局安装（`npm i -g`），不要用 npx 跑服务**：launchd plist 里硬编码了 CLI 路径，而 npx 的临时缓存（`~/.npm/_npx/...`）会被清理，缓存一没服务就起不来。前台 `start` 扫码用 npx 没问题（单次进程）。
>
> 前台直接跑（`feishu-codex-bridge start` / `./scripts/dev-run.sh`）只适合**首次扫码或开发调试**，不要用来长期挂着。

自检随时可用：`feishu-codex-bridge doctor`。

---

## 🔧 飞书开放平台后台配置（关键，必须手动一次）

扫码向导只负责**创建应用 + 拿到凭据**。下面这些飞书**没有开放 API**，必须你在[开发者后台](https://open.feishu.cn/app)手动配一次（Lark 为 <https://open.larksuite.com/app>）：

### 1）开通权限（Scope）

启动时若有缺失权限，终端会打印形如 `https://open.feishu.cn/app/<app_id>/auth?q=...` 的链接，**点开 → 一次性勾选全部 → 确认**即可（即时生效、无需重启）。

本桥需要的全部权限以 [`src/config/scopes.ts`](src/config/scopes.ts) 的 `REQUIRED_SCOPES` 为权威清单，包含：收群 @ 消息 / 全量群消息（免 @）/ 私聊消息、以机器人身份发消息与回话题、消息置顶、表情回复、上传下载资源、建群 / 转让群主、群公告读写、置顶横幅、群标签页、交互卡片。**这些都在首次开通链接里一并申请，正常用不会再遇到「权限不足」。**

### 2）订阅事件（长连接模式）

后台「**事件与回调**」→ 选择**长连接**方式 → 订阅以下事件：

- `im.message.receive_v1` —— 收群/私聊消息
- `card.action.trigger` —— 卡片按钮回调
- `application.bot.menu_v6` —— 机器人菜单点击

> ⚠️ 不订阅事件，长连接能连上但收不到任何消息（表现为：@ 机器人没反应）。

### 3）（可选）机器人自定义菜单

后台「**机器人能力 → 机器人自定义菜单**」配置菜单项（如：新建项目 / 项目列表 / 设置 / 诊断 / 重连），各设一个推送事件的 `event_key`，发布版本生效。不配也能用 —— 私聊机器人发任意消息同样会弹出交互菜单。

### 4）发布版本

在后台发布应用版本，机器人才真正上线。

---

## 💬 使用

- **建项目**：私聊机器人 → 弹出控制台菜单 → 「新建项目」→ 绑定一个本地目录（或新建空白项目）→ 机器人建好群、置顶命令说明、把你拉进去。
- **干活**：在项目群里 **@机器人** 描述需求；机器人在该群绑定的目录里跑 Codex，流式卡片回结果。
- **话题 = 会话**：对某条消息开话题后，话题内可**免 @** 连续对话，是一条连贯的 Codex 会话。
- **终止**：卡片上的 **⏹** 随时终止当前轮；卡死超过 watchdog 阈值（默认 120s）自动中止并回收进程。
- **私聊控制台**：项目列表、设置（模型 / 推理强度 / 免 @ / watchdog / 管理员）、诊断、重连，全在私聊菜单里。

---

## ⚙️ 配置与数据位置

所有本地状态在 `~/.feishu-codex-bridge/`：

| 文件 | 内容 |
|------|------|
| `config.json` | 应用 id / 租户 / 偏好（**不含明文密钥**） |
| `secrets.enc` + `.keystore.salt` | AES-256-GCM 加密的应用密钥（密钥由机器 + 用户派生） |
| `projects.json` | 群 → 目录 + 默认参数 注册表 |
| `sessions.json` | 话题 → Codex thread_id + cwd |
| `media/` | 临时媒体 |

环境变量：

| 变量 | 作用 |
|------|------|
| `CODEX_BIN` | 显式指定 codex 二进制路径 |
| `CODEX_HOME` | codex 配置/登录目录（默认 `~/.codex`） |
| `FEISHU_CODEX_CWD` | 未注册群的兜底工作目录（默认进程 cwd；常驻服务建议显式设置） |

> 群里那张「👈 使用说明」标签页指向的命令手册文档，可在 [`src/project/onboarding.ts`](src/project/onboarding.ts) 的 `HELP_DOC_URL` 改成你自己发布的飞书文档；设为空串则不挂该标签页。

---

## 🛠 CLI 一览

```
feishu-codex-bridge start              扫码 onboarding + 启动 bot（前台）
feishu-codex-bridge doctor             本地自检：codex / 登录 / lark-cli / 配置
feishu-codex-bridge secrets get|set <id>|list|remove <id>    本地加密密钥库
feishu-codex-bridge service ...        后台常驻服务（见上）
```

---

## 🧑‍💻 开发

```bash
npm run typecheck     # tsc --noEmit
npm run build         # tsup → dist/
npm test              # vitest
npm run dev           # tsup --watch
```

本地开发：`git clone https://github.com/modelzen/feishu-codex-bridge.git && cd feishu-codex-bridge && npm i`（`prepare` 自动构建），前台跑 `npm start` 或 `./scripts/dev-run.sh`。

目录结构：

```
src/
  bot/        长连接 bridge、消息处理、私聊控制台、扫码向导
  card/       流式运行卡片、命令卡、回调分发
  agent/      Codex app-server 后端（进程生命周期、JSON-RPC、事件映射、协议类型）
  project/    项目注册表、建群/公告/标签页 onboarding、生命周期
  config/     加密密钥库、密钥解析、配置存储、scope 清单、路径
  core/       watchdog、单实例锁、日志
  cli/        commander 命令（start / doctor / secrets / service）
  service/    launchd 后台服务
```

架构与实现细节见 [`docs/design/feishu-codex-bridge-design.md`](docs/design/feishu-codex-bridge-design.md) 与 [`docs/design/implementation-plan.md`](docs/design/implementation-plan.md)。

---

## ❓ 故障排查

| 现象 | 排查 |
|------|------|
| `✗ 未找到 codex CLI` | 装 Codex 并 `codex login`；或设 `CODEX_BIN`。`doctor` 会显示解析到的路径 |
| `应用凭据校验失败` | 应用可能被禁用/未发布；重跑 `start` 走扫码 |
| @ 机器人没反应 | 多半是**事件未订阅**（长连接模式）或**版本未发布**；按上面「后台配置」检查 |
| 提示某项「权限不足」 | 点 `start` 打印的一键开通链接补齐权限（即时生效） |
| 按钮「时灵时不灵」 | 检查是否**重复启动了两个 bridge 进程**抢回调；本桥有单实例锁，正常会拒绝第二个 |
| 点 ⏹ 没反应 / 卡片不收尾 | 同群另一话题在跑长任务占住了串行队列；稍候或重连 |

---

## 💬 文档 & 交流

- 📖 **命令手册（飞书文档）**：<https://my.feishu.cn/wiki/PZ23wGr7JiKK5RkIG4rcZXzGn5g> —— 各场景可用命令速查（机器人建群时也会自动挂成群标签页）。
- 🐛 **反馈 / 贡献**：<https://github.com/modelzen/feishu-codex-bridge/issues>
- 👥 **交流群**：扫码加入「Vonvon 灵感研究所」👇

<p align="center"><img src="docs/assets/vonvon-group-qr.png" alt="Vonvon 灵感研究所 群二维码" width="260"></p>

> 该群二维码永久有效，扫码即可加入。

---

## 📄 License

[MIT](LICENSE) © modelzen
