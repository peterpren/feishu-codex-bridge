# feishu-codex bridge

[![npm version](https://badgen.net/npm/v/peterpren-feishu-codex-bridge)](https://www.npmjs.com/package/peterpren-feishu-codex-bridge)
[![total downloads](https://badgen.net/npm/dt/peterpren-feishu-codex-bridge)](https://www.npmjs.com/package/peterpren-feishu-codex-bridge)
[![downloads/month](https://badgen.net/npm/dm/peterpren-feishu-codex-bridge)](https://www.npmjs.com/package/peterpren-feishu-codex-bridge)
[![license](https://badgen.net/npm/license/peterpren-feishu-codex-bridge)](https://github.com/peterpren/feishu-codex-bridge/blob/main/LICENSE)

> 把飞书 / Lark 桥接到你本机的 [Codex](https://github.com/openai/codex)，在群里 @ 机器人就能让 Codex 在指定项目目录里干活，结果以流式 Markdown 卡片实时回到群里。
>
> **项目 = 群 = 固定工作目录（cwd）**，**话题（thread）= 一个 Codex 会话（session）**；多话题群默认给每个话题分配独立本地工作区。

一句话：你在飞书群里发「帮我加个登录接口」，机器人就在这个群绑定的代码目录里跑 Codex，边跑边把推理、命令、改动、结果更新到一张卡片上；点 ⏹ 可随时终止。

> 🚀 **最快上手：把这个仓库链接 `https://github.com/peterpren/feishu-codex-bridge` 交给 Codex / Claude，照着本 README 它就能帮你把整套装好跑起来。**

```
飞书群消息 ──长连接(WSClient)──▶ bridge ──JSON-RPC/stdio──▶ codex app-server (每会话一进程)
   ▲                                  │
   └──────── 流式 Markdown 卡片 ◀──────┘
```

---

## ✨ 特性

- **群 = 项目**：每个群绑定一个本地目录与默认参数；新建/绑定项目必须落在该 Bot 的本地工作根目录内，@ 机器人即在该项目边界内跑 Codex。
- **话题 = 会话**：在群里对某条消息开话题，话题内是一条连续的 Codex 会话（自动 resume）；多话题群默认每个话题一个独立可写目录。
- **看得见话题上下文**：引用某条消息 @ 机器人时，会把被引用消息一并交给 Codex；话题里先有人讨论、再 @ 机器人时，会补充此前未喂给 Codex 的话题上文。
- **流式卡片**：推理 / 命令 / 文件改动 / 结果实时刷新到一张可折叠卡片。
- **免 @ 对话**：项目群可逐群开启免 @；多话题群的话题默认需 @，避免多人群里普通聊天被误接管。
- **文档评论回复（可选）**：在飞书云文档（doc/docx/sheet/file，含知识库 wiki）的评论里 **@机器人**，它会读评论、跑 Codex、把答案回到同一条评论线程里；每篇文档一条连续会话。需额外开通文档评论权限并订阅评论事件（见下方配置）。
- **私聊控制台**：私聊机器人弹交互菜单 —— 新建项目、项目列表、设置、用量、诊断、重连。
- **📊 Codex 用量**：5 小时 / 7 天限额进度（剩余 % + 重置时间）、lifetime tokens、连续使用天数、GitHub 风格每日用量热力图；一键生成**战绩分享卡**，可原生转发给任何人或群（数据来自 Codex 个人资料页同款接口，需 ChatGPT 登录）。
- **稳定隔离**：每会话独立 app-server 进程；卡死有 watchdog（默认 120s）→ 终止 → 回收，异常不波及其他群。
- **本地加密密钥库**：飞书应用密钥用 AES-256-GCM 存在 `~/.feishu-codex-bridge/`，不入仓库、不进环境变量。
- **跨平台常驻**：macOS / Windows / Linux·WSL 均可注册成后台服务、开机或登录自启（分别走 launchd / 登录自启免管理员 / systemd）。注：跨平台指进程运行与后台自启；「项目内只读/读写」隐私沙箱仅 macOS / 原生 Windows 可强制（见[安全须知](#-安全须知)）。

---

## 📦 前置条件

| 依赖 | 说明 | 获取方式 |
|------|------|----------|
| **操作系统** | 运行/后台常驻：**macOS / Windows** 均支持，Linux·WSL 为 best-effort（已实现 systemd，未广泛实测）。注意：「项目内只读 / 读写」隐私档的沙箱强制仅 **macOS / 原生 Windows**，Linux·WSL 上这两档会 fail-closed 拒绝启动（见下方[安全须知](#-安全须知)） | — |
| **Node.js ≥ 20** | 运行时 | <https://nodejs.org> 或 `nvm install 20` |
| **Codex CLI** | 后端，bridge 会 spawn `codex app-server` | `npm i -g @openai/codex`，或装 Codex.app，或用 `CODEX_BIN` 指向已有二进制 |
| **Codex 已登录** | app-server 需要 `~/.codex/auth.json` | `codex login` |
| **飞书 / Lark 账号** | 租户需允许「扫码创建应用」（个人/开发者租户一般可以） | 首次 `run` 时扫码创建 |
| **lark-cli**（可选） | 仅「文档评论回复」需读文档正文时用到；不装也能跑，只是读不到正文 | `lark-cli auth login`，确保在 PATH 上 |

> 收发消息、回卡片、发评论回复均走 `@larksuiteoapi/node-sdk` 长连接，**不依赖** `lark-cli`。⚠️ `lark-cli` 以**你的身份**登录，仅供 Codex **读**文档；prompt 已禁止用它发评论（否则评论会署你本人）。

---

## 🚀 安装与启动

### 1. 安装

```bash
# 推荐：全局安装到稳定路径（后台 daemon 需要稳定的 CLI 路径）
npm i -g peterpren-feishu-codex-bridge

# 或：免安装、单次前台运行
npx -y peterpren-feishu-codex-bridge run
```

> 安装只装命令、**不会自动建机器人**（包已预编译，安装即用）；装好后命令名是 `feishu-codex-bridge`。

### 2. 前台启动（`run`）

```bash
feishu-codex-bridge run
```

`run` 没配置时会**先扫码 init**：检查 codex → 扫码创建/授权飞书应用（密钥进本地加密库）→ 校验凭据并**自动打开浏览器到「一键开通全部权限」页**（同时打印链接）→ 起长连接。**Ctrl+C 优雅退出**（关掉所有 codex 子进程，无孤儿）。支持 npx。

> 权限即时生效：`run` 跑着时直接在浏览器开通权限即可，无需重启。另外还要去飞书后台**订阅事件 + 发布版本**（见下节）。

### 3. 后台 daemon（`start` —— 日常这么跑）

```bash
feishu-codex-bridge start      # 装系统后台服务并启动：开机/登录自启、崩溃自动拉起、关终端照跑
feishu-codex-bridge status     # 状态 / pid / 日志路径 / 上次退出码
feishu-codex-bridge logs -f    # 跟踪日志
feishu-codex-bridge restart    # 重启
feishu-codex-bridge stop       # 停止并关闭开机自启
feishu-codex-bridge update     # 更新到最新版（npm i -g）并自动重启 daemon（--check 只查不装）
```

> 💡 升级很省事：装了后台 daemon 的，直接 `feishu-codex-bridge update` 一条命令 = 拉最新版 + 自动 `restart`。

`start` 会**先在当前终端完成 init**（没配置则扫码），并**阻塞到授权完成**——权限全部开通、且你确认已订阅事件/发布版本——才真正装服务，绝不会装一个收不到消息的空壳。daemon 体跑的就是 `run`。

> 🖥 **各平台后台机制**：macOS = launchd 用户服务；**Windows = 登录自启（写 `HKCU\…\Run`，隐藏启动，全程免管理员）**；Linux·WSL = systemd 用户单元（`systemctl --user`，需要 `loginctl enable-linger` 才能登出后续跑；WSL 还需在 `/etc/wsl.conf` 开 `[boot] systemd=true`，否则用前台 `run`）。三者命令一致（`start`/`status`/`stop`/`restart`/`logs`），状态/日志路径统一。

> ⚠️ **后台服务必须全局安装（`npm i -g`），不要用 npx**：服务里硬编码了 CLI 路径，而 npx 的临时缓存（`~/.npm/_npx/...`）会被清理，缓存一没服务就起不来。前台 `run` 用 npx 没问题（单次进程）。

### 4. 多飞书机器人（可选）

一台机器可保存多个机器人配置，运行时只用「当前」一个：

```bash
feishu-codex-bridge bot init [名]   # 再注册一个飞书应用并授权（额外机器人）
feishu-codex-bridge bot list        # 列出已注册机器人（👉 标当前）
feishu-codex-bridge bot use <名>    # 切换 run / start 启动时使用的机器人
feishu-codex-bridge bot rm <名>     # 移除一个机器人配置
```

每个机器人的 projects / sessions / 设置各自独立（`~/.feishu-codex-bridge/bots/<appId>/`）。建议每个部门 Bot 在私聊控制台「设置 → 本地工作根目录」里配置独立目录；后续新建或绑定项目只能使用该目录内的文件夹。切换后前台 `run` 直接生效，后台 `restart` 生效。

自检随时可用：`feishu-codex-bridge doctor`。

---

## 🔧 飞书开放平台后台配置（关键，必须手动一次）

扫码向导只负责**创建应用 + 拿到凭据**。下面这些飞书**没有开放 API**，必须你在[开发者后台](https://open.feishu.cn/app)手动配一次（Lark 为 <https://open.larksuite.com/app>）：

### 1）开通权限（Scope）

启动时若有缺失权限，会**自动打开浏览器**到形如 `https://open.feishu.cn/app/<app_id>/auth?q=...` 的页面（同时在终端打印链接），**一次性勾选全部 → 确认**即可（即时生效、无需重启）。`start`（后台 daemon）会阻塞到这步开通完成才装服务。

本桥需要的全部权限以 [`src/config/scopes.ts`](src/config/scopes.ts) 的 `REQUIRED_SCOPES` 为权威清单，包含：收群 @ 消息 / 全量群消息（免 @）/ 私聊消息、以机器人身份发消息与回话题、消息置顶、表情回复、上传下载资源、建群 / 转让群主 / 设群管理员、群公告读写、置顶横幅、群标签页、交互卡片。**这些都在首次开通链接里一并申请，正常用不会再遇到「权限不足」。**

> 「**文档评论回复**」功能另需 `docs:document.comment:read`、`docs:document.comment:create`、`wiki:wiki:readonly` 三项（见 `COMMENT_SCOPES`）。它们**已预勾选进同一个开通链接**，但**不属于** `REQUIRED_SCOPES` —— 不开通也不会卡住后台服务安装，只是该功能静默关闭。

> 「**把我加进已有群**」功能另需 `im:chat:readonly`（读群名）、`im:chat.members:write_only`（解绑时机器人退群）两项（见 `JOIN_GROUP_SCOPES`）。同样**已预勾选进同一个开通链接**、**不属于** `REQUIRED_SCOPES`，不开通只是该功能静默关闭。

> 「**飞书云文档目录隔离**」功能另需 `drive:file`、`docs:permission.member:create`、`docs:permission.member:delete` 三项（见 `CLOUD_DOC_FOLDER_SCOPES`）。不开通不会影响群聊/Codex 对话，但无法自动创建话题云文档子文件夹、授权话题发起人，或回收旧的群文件夹权限。

### 2）订阅事件 + 回调（长连接模式）

`run` / `start` 初始化到这步会**自动打开**「**事件与回调**」页（`https://open.feishu.cn/app/<app_id>/event`）。这页顶部有「**事件配置**」「**回调配置**」两个独立标签，要分别配（飞书对事件/回调**既无开通 API、也无预选深链、连查询订阅状态的接口都没有**，只能手点）：

**「事件配置」标签** → 「订阅方式」改**长连接** → 点「添加事件」：

- `im.message.receive_v1` —— 收群/私聊消息
- `application.bot.menu_v6` —— 机器人菜单点击
- `drive.notice.comment_add_v1` —— 云文档新增评论（**仅「文档评论回复」功能需要**；不加则该功能静默关闭，其余照常）
- `im.chat.member.bot.added_v1` —— 机器人被加入群（**仅「把我加进已有群」功能需要**；触发私聊推送绑定卡，不加则拉我进群没反应）
- `im.chat.member.bot.deleted_v1` —— 机器人被移出群（同上；触发自动解绑项目，不加则被踢后项目不会自动清理）

**「回调配置」标签** → 「订阅方式」改**长连接** → 点「添加回调」：

- `card.action.trigger`（卡片回传交互）—— 卡片按钮回调

> ⚠️ `card.action.trigger` 是**回调**不是事件，在「添加事件」里**搜不到**，必须切到「**回调配置**」这个标签去加。
> ⚠️ 不订阅事件 → @ 机器人没反应；不订阅回调 → 卡片按钮点了没反应（长连接照样能连上，但都收不到）。
> 保存「长连接」订阅方式时要求长连接**在线**；若提示连接未建立，先开个终端跑 `feishu-codex-bridge run` 连上，再回这页保存。

### 3）（可选）机器人自定义菜单

后台「**机器人能力 → 机器人自定义菜单**」配置菜单项（如：新建项目 / 项目列表 / 设置 / 诊断 / 重连），各设一个推送事件的 `event_key`，发布版本生效。不配也能用 —— 私聊机器人发任意消息同样会弹出交互菜单。

### 4）发布版本

在后台发布应用版本，机器人才真正上线。

---

## 💬 使用

- **先设本地根目录**：私聊机器人 →「设置」→「本地工作根目录」→ 填这个 Bot 可使用的本地目录。目录不存在会自动创建。
- **建项目**：私聊机器人 → 弹出控制台菜单 →「新建项目」→ 本地路径留空会在 Bot 根目录下新建空白项目；手填绝对路径必须在 Bot 根目录内 → 选群类型 → 机器人建好群、置顶命令说明、把你拉进去。
- **两种群按场景选**：
  - **👥 多话题群**：主群区 @ 机器人开话题，每个话题是一条**独立会话**，并默认落到独立本地工作区 `项目目录/.feishu-codex/topics/<话题>/`。只有话题发起人或管理员能驱动该话题。话题内默认也需 @；管理员可在 `/settings` 开启免 @。适合**多人协作**——一个项目群里各人 / 各任务开各自话题、上下文和文件互不串味；也适合一人并行多任务。
  - **💬 单会话群**：整群就是**一条连续会话**（机器人创建的新群默认**免 @**、消息按序排队、无 `/resume`；绑定已有群默认需 @）。适合**个人单线深入**、像私聊一样直接聊。
- **干活**：在项目群里 **@机器人** 描述需求；多话题群会在该群绑定目录下创建话题专属本地工作区，流式卡片回结果。只有涉及创建飞书文档、文件传输或直接发送附件时，才会在配置的飞书父文件夹下创建话题专属云文档子文件夹并授权。
- **话题 = 会话**：对某条消息开话题后，话题就是一条连贯的 Codex 会话；默认 @ 机器人继续，开启免 @ 后可直接连续对话。
- **文件和引用**：话题内直接发文件不用 @，Bridge 会把附件下载到该话题工作区并提示 Codex 读取；引用别人消息再 @ 机器人时，被引用内容会自动补进本轮上下文。
- **文档评论 @机器人**：在飞书文档评论里 @ 它就回（前提：已开通文档评论权限 + 订阅 `drive.notice.comment_add_v1`，且机器人对该文档有访问权限）。只支持 doc/docx/sheet/file；评论框不渲染 markdown，回复为纯文本，超长会截断。
- **终止**：卡片上的 **⏹** 随时终止当前轮；卡死超过 watchdog 阈值（默认 120s）自动中止并回收进程。
- **私聊控制台**：项目列表、设置（模型 / 推理 / 速度 / 免 @ / watchdog / 管理员）、用量、诊断、重连，全在私聊菜单里。
- **📊 用量**：点「用量」看 5h/7d 限额（剩余 % + 重置时间）与 Codex 个人统计（lifetime tokens / streak / 每日热力图）；点「📤 生成分享卡」得到一张可转发的战绩卡——长按（手机）或右键（电脑）即可转发，数据定格在生成时刻。

---

## ⚙️ 配置与数据位置

所有本地状态在 `~/.feishu-codex-bridge/`：

| 文件 | 内容 |
|------|------|
| `bots.json` | 已注册机器人列表 + 当前选中（`current`） |
| `bots/<appId>/config.json` | 该机器人的 id / 租户 / 偏好（**不含明文密钥**） |
| `bots/<appId>/projects.json` | 群 → 目录 + 默认参数 注册表（**按机器人隔离**） |
| `bots/<appId>/sessions.json` | 话题 → Codex thread_id + cwd + 上下文水位（**按机器人隔离**） |
| `bots/<appId>/runs/YYYY-MM-DD.jsonl` | 每轮运行的开始 / 结束 / 故障摘要（按机器人、按日期记录） |
| `<项目目录>/.feishu-codex/topics/<话题>/` | 多话题群的话题专属本地工作区 |
| `secrets.enc` + `.keystore.salt` | AES-256-GCM 加密的应用密钥（按 appId 存，多机器人共用一库；密钥由机器 + 用户派生） |
| `media/` | 临时媒体 |

> `bots/<appId>/config.json` 里的 `preferences.localWorkspaceRoot` 是该 Bot 的本地工作根目录。未配置时，不能新建或绑定项目；已存在的老项目不会被自动迁移。

> 旧版单机器人布局（顶层 `config.json` / `projects.json` / `sessions.json`）会在首次运行时**自动迁移**为名为 `default` 的机器人。

环境变量：

| 变量 | 作用 |
|------|------|
| `CODEX_BIN` | 显式指定 codex 二进制路径 |
| `CODEX_HOME` | codex 配置/登录目录（默认 `~/.codex`） |
| `FEISHU_CODEX_CWD` | 未注册群的兜底工作目录（默认进程 cwd；常驻服务建议显式设置） |

## 🛠 CLI 一览

```
feishu-codex-bridge run                前台启动（没配置先扫码 init；Ctrl+C 优雅退出）
feishu-codex-bridge start              后台 daemon 启动（装系统后台服务、开机/登录自启；阻塞到授权完成）
feishu-codex-bridge stop|restart|status|logs   后台 daemon 生命周期
feishu-codex-bridge update             更新到最新版并自动重启 daemon（--check 只查不装）
feishu-codex-bridge bot init|list|use|rm       多飞书机器人：注册 / 列表 / 切当前 / 移除
feishu-codex-bridge doctor             本地自检：codex / 登录 / lark-cli / 当前机器人
feishu-codex-bridge food-mcp status    瑞幸/麦当劳 MCP Token、项目启用与 bot 授权状态
feishu-codex-bridge food-mcp probe     只连接餐饮 MCP 并列工具清单，不调用下单工具
feishu-codex-bridge food-mcp enable-project <项目名>   为项目启用餐饮 MCP（多 bot 可加 --bot）
```

餐饮 MCP 的 Token 存本机密钥库，不要发到飞书或聊天里：

```bash
feishu-codex-bridge food-mcp set-token luckin
feishu-codex-bridge food-mcp set-token mcd
feishu-codex-bridge restart
feishu-codex-bridge food-mcp status
feishu-codex-bridge food-mcp probe
```

`set-token` 会在终端隐藏输入；自动化脚本仍可用 stdin 传入。

---

## 🧑‍💻 开发

```bash
npm run typecheck     # tsc --noEmit
npm run build         # tsup → dist/
npm test              # vitest
npm run dev           # tsup --watch
```

本地开发：`git clone https://github.com/peterpren/feishu-codex-bridge.git && cd feishu-codex-bridge && npm i`（`prepare` 自动构建），前台跑 `npm start` 或 `./scripts/dev-run.sh`。

目录结构：

```
src/
  bot/        长连接 bridge、消息处理、私聊控制台、扫码向导
  card/       流式运行卡片、命令卡、回调分发
  agent/      Codex app-server 后端（进程生命周期、JSON-RPC、事件映射、协议类型）
  project/    项目注册表、建群/公告/标签页 onboarding、生命周期
  config/     加密密钥库、密钥解析、配置存储、多机器人注册表、scope 清单、路径
  core/       watchdog、单实例锁、日志
  cli/        commander 命令（run / start / stop / restart / status / logs / update / bot / doctor / secrets）
  service/    后台服务适配器（launchd / Windows 登录自启 / systemd）+ 跨平台 spawn
```

架构与实现细节见 [`docs/design/feishu-codex-bridge-design.md`](docs/design/feishu-codex-bridge-design.md) 与 [`docs/design/implementation-plan.md`](docs/design/implementation-plan.md)。

---

## ⚠️ 安全须知

机器人调用 Codex 始终是 **`approvalPolicy: "never"`**（无人工逐条审批），**沙箱就是唯一的安全闸门**。每个项目有一档**权限**，在私聊控制台「📁 项目列表 → ⚙️ 设置 → 🔐 权限」里用下拉框选择后提交：

| 档位 | 能读 | 能写 | 适用 |
|------|------|------|------|
| 🔒 **项目内只读** | 仅项目文件夹 | ✗ | 外部群 / 不可信场景的问答机器人 |
| ✏️ **项目内读写** | 仅项目文件夹 | 仅项目文件夹 | 自己的编码项目，但禁止它碰机器其余部分 |
| ⚠️ **完全访问** | 整台电脑 | 整台电脑 | 完全信任、你自己掌控的机器 |

- **管理员 / 普通用户可分设**：🔐 权限里有「管理员档」和「普通用户档」两个下拉。两档**不同**时，管理员与群里其他人**各用独立的 Codex 线程**（互不串沙箱、也互不串对话历史）——典型：外部群里管理员 `完全访问`、其他人 `项目内只读`。两档**相同** = 所有人一致（默认）。
- **默认值**：你自己新建的项目群 = `完全访问`（与历史行为一致）；**别人把机器人拉进的存量/外部群** = `项目内只读`；普通用户档默认**同管理员档**（不分档）。**升级前没有 `mode` 字段的老项目按 `完全访问` 处理**，行为不变。
- 🔒/✏️ 靠 Codex 的自定义 permissions 档把读写都**锁死在项目文件夹内**（读不到 `~/.ssh`、`/etc` 等），由操作系统沙箱强制：**macOS（Seatbelt）与原生 Windows（restricted token）可强制**，其中 Windows 需 Codex 以 elevated 沙箱运行、否则它会**拒绝执行**（仍不泄漏）。**Linux / WSL 无法强制读限定**（沙箱只挡写、不限读，Landlock 读限制尚未实现，WSL 等同 Linux）——在这些平台选 🔒/✏️ 会被**直接拒绝启动（fail-closed），绝不静默降级为完全访问**；要在 Linux/WSL 用，请把 Codex 跑在容器/隔离环境里。
  > Windows 上的强制是 Codex 自己做的，请先在真机自测一次（让机器人读项目文件夹外的文件，应被拒）再用于真实外部群。
- 「联网」是档位之外的独立开关，只影响它执行的 shell 命令能否上网，不影响模型本身和 Codex 自带的联网搜索。
- **多话题隔离**：多话题群默认把每个话题的会话 cwd 指向 `项目目录/.feishu-codex/topics/<话题>/`；普通成员只能驱动自己发起的话题，Codex 只能在该话题专属目录里动作；管理员可驱动任意话题。单会话群仍是整群共享项目 cwd。
- **Bot 根目录隔离**：每个 Bot 可配置独立的本地工作根目录；新建/绑定项目会校验真实路径，手填目录和软链接最终指向都必须在该根目录内。这样一个 Codex 同时接多个部门 Bot 时，可以先从逻辑层面把项目目录分开。
- **飞书云文档隔离**：项目配置里的云文档目录只是父文件夹，不再自动授予整个群编辑权限；父文件夹只配置管理员和机器人权限。多话题群只有在话题涉及飞书文档/文件时，才会在父文件夹下创建话题子文件夹，只给话题原始发起人编辑权限，管理员保留全量权限；已创建的子文件夹会随 `/rename` 同步改名。若旧版本已给群授权，保存/绑定该目录时会尝试回收该群的 `openchat` 权限。
- ⚠️ `完全访问` 档意味着：**任何能给机器人发消息的人，都能在你这台机器上、以你的身份执行任意命令（读写文件、联网、跑脚本）**。这一档只把**你信任的人**拉进群，在**你自己掌控的隔离机器/账号**上跑，目录里别放不愿被读写的敏感数据。
- 如需比项目目录更强的读取隔离，请把 bridge 跑在独立 macOS 用户、容器或专门开发机里。
- 它不是多租户托管服务，是给你（和你信任的小团队）自用的桥。

> 把机器人拉进**外部群**做只读问答前，先在飞书开发者后台开启应用的「可被添加到外部群 / 外部可用范围」，再由群里的真人手动把机器人加进群（机器人无法自行加入）。

---

## ❓ 故障排查

| 现象 | 排查 |
|------|------|
| `✗ 未找到 codex CLI` | 装 Codex 并 `codex login`；或设 `CODEX_BIN`。`doctor` 会显示解析到的路径 |
| `应用凭据校验失败` | 应用可能被禁用/未发布；重跑 `run` 重新校验，或 `bot rm <名>` 后 `bot init` 重新扫码 |
| @ 机器人没反应 | 多半是**事件未订阅**（长连接模式）或**版本未发布**；按上面「后台配置」检查 |
| 提示某项「权限不足」 | 点 `run`/`start` 打印（或自动打开）的一键开通链接补齐权限（即时生效） |
| 按钮「时灵时不灵」 | 检查是否**重复启动了两个 bridge 进程**抢回调；本桥有单实例锁，正常会拒绝第二个 |
| 点 ⏹ 没反应 / 卡片不收尾 | 同群另一话题在跑长任务占住了串行队列；稍候或重连 |

---

## 💬 反馈 & 交流

- 🐛 **反馈 / 贡献**：<https://github.com/peterpren/feishu-codex-bridge/issues>
- 👥 **交流群**：扫码加入「Vonvon 灵感研究所」👇

<p align="center"><img src="docs/assets/vonvon-group-qr.png" alt="Vonvon 灵感研究所 群二维码" width="300"></p>

---

## 📄 License

[MIT](LICENSE) © peterpren
