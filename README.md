# NifeCode

轻量的 VS Code 兼容编辑器：Tauri 2 + Monaco（VS Code 的编辑器内核）+ 本地 PTY 终端 + SSH + Agent Bridge。

Windows 下 release 版常驻内存实测：**175MB**（编辑器 + 文件树 + 1 个终端）、**213MB**（再加到 3 个终端）；VS Code 同类场景通常 500MB+，界面/快捷键/主题/输入法与 VS Code 一致，菜单和提示全中文。

> dev 模式（`pnpm tauri dev`，Vite 未压缩 + HMR）内存会到 600~700MB，这是开发模式开销，不代表发布版。

## 现在能用的

- 打开本地文件夹，懒加载文件树
- Monaco 编辑：语法高亮、多光标、折叠、查找替换、minimap，`Ctrl+S` 保存
- 标签页 + 未保存标记（`●`）
- 左侧活动栏、文件图标、状态全用**自绘 SVG**（`src/icons.ts`），不用 emoji、不引图标字体
- **资源管理器会自己刷新**：只 stat 当前根目录 + 已展开的目录，变了才重画（本地 1.5s / 远端 5s 一次），展开状态保留
- **右键菜单**：新建文件 / 新建文件夹 / 重命名 / 删除 / 复制 / 剪切 / 粘贴（剪贴板记着来源机器，本地文件不会粘到远端去）；`/` 和盘符根目录有保护，不会误删
- **三栏布局**：文件管理 ｜ 编辑器 ｜ 终端，**三条边界都能拖**（侧栏 150~700px，终端 240px 起），宽度存 localStorage，重启保留
- **终端列分页**：一页 = 一组互相独立的终端（标签栏 `页 1 / 页 2 / ＋`）；页内 `＋` 再开一个终端，上下堆叠，**终端之间的横条可以拖**调各自高度；关掉页里最后一个终端会自动关掉这页
- 终端栏不会空着：启动就有 `页 1` + 一个 shell，关掉最后一页也立刻补一个
- 一个页里只有 1 个终端时不显示它的小标题栏（省一行），开到第 2 个才出现 `终端 1 · 本地 ✕`；`✕` 只在多于一个页/终端时出现，不会误关
- **外部改动检测**：文件被别的程序（比如 agent）改动后自动重载；你有未保存改动时会弹窗让你选"用磁盘版本 / 保留我的"
- **本地终端**：`xterm.js` + 真实 PTY，支持中文、颜色、resize，可多开
- **终端类型可选**：终端栏的 `˅` 列出这台机器上能用的 shell —— PowerShell（默认）/ cmd / Git Bash / WSL 各发行版；选过的会记住，下次新建终端就用它。工作目录自动跟随当前工作区（WSL 里是 `/mnt/d/...`）
- **输入中文不闪**：终端自己的滚动条改成不占布局宽度，`pty_resize` 加了 80ms 去抖 —— 否则宽字符一进来列数就来回跳，TUI（比如 nife）会整屏重绘
- **SSH**：连远端机器，浏览/编辑/保存远端文件；连上后点终端 `＋` 直接开远端 shell（走交互式 PTY，**密码登录在这里可用**）
- **全项目搜索**：左侧 🔍，本地进程内遍历，远端跑一条 `grep -rn`；点结果直接跳到对应行
- **端口转发**：把 GPU 服务器上的 Jupyter / TensorBoard 映射到本地（命令面板 → 端口转发，或状态栏点转发标记停止）
- **源代码管理**：左侧 ⎇ 面板，显示分支、变更文件列表；点文件直接打开，`⇄` 和 HEAD 对比；底部填提交信息（`Ctrl+Enter`）一键 `add -A` + commit
- **Agent Bridge**：本地 HTTP 接口，让 agent 打开文件、给修改方案看 diff

## 跑起来

```bash
pnpm install
pnpm tauri dev          # 开发（内存偏高，正常）
pnpm tauri build        # 打包安装程序（NSIS）
```

只想用 release 二进制、不想打包：

```bash
pnpm build && cd src-tauri && cargo build --release --features custom-protocol
# 产物：src-tauri/target/release/nifecode.exe
```

`--features custom-protocol` 不能省，否则 release 版会去连 `localhost:1420`（`tauri build` 会自动加）。

> ⚠️ release 二进制把 `dist/` **编译时内嵌**。改了前端只跑 `pnpm build` 是不会生效的，必须重新 `cargo build --release`（或者干脆用 `pnpm tauri dev`，Vite 热更新）。

前提：Rust（MSVC 工具链）+ Node 18+ + WebView2（Win11 自带）。

## 打包 / 发布

`pnpm tauri build` 之后能出两个 Windows 产物：

| 产物 | 路径 | 说明 |
|---|---|---|
| 免安装单文件 | `src-tauri/target/release/nifecode.exe` | 双击就跑，不写注册表、不进开始菜单，放哪都行 |
| 安装包 | `src-tauri/target/release/bundle/nsis/NifeCode_0.1.0_x64-setup.exe` | NSIS，装到 `%LOCALAPPDATA%`，带开始菜单和卸载项 |

两个都**不需要额外文件**（前端已内嵌进 exe）。免安装版就是那个普通 release 二进制，改个名而已：

```bash
cp src-tauri/target/release/nifecode.exe NifeCode_0.1.0_x64_portable.exe
```

## 快捷键

| 键 | 作用 |
|---|---|
| `Ctrl+S` | 保存 |
| `Ctrl+`` ` | 显示/隐藏终端列 |
| `Ctrl+Shift+P` | 命令面板（打开文件夹 / SSH / 终端 / 保存） |
| `Esc` | 关闭弹窗 |

## SSH

点左侧 🔌 是**连接管理面板**，连接信息会保存下来（存在 localStorage，重启还在）：

- `＋` 新建：名称 / `user@host`（也支持 `~/.ssh/config` 里的别名）/ 端口 / 私钥路径（可选）/ **密码（可选）**
- 点一行直接连；鼠标悬停出现 `✎` 编辑、`✕` 删除
- **点下去 80ms 内顶部就多一个标签**（状态栏显示"连接中…"），连上后填内容；连不上就把那个空标签收回并弹原因，不会留个死标签
- 不同机器可以**同时连着**，各自一个上下文标签，随时切

### 连接为什么不会卡

三个坑都踩过并修掉了：

1. **sync 命令跑在主线程** → 一次 ssh 就能把整个界面冻住。现在所有 IO 命令都是 `async`，界面永远不阻塞（实测连接过程中主线程最大卡顿 **6ms**）
2. **askpass 助手没被认出来** → Windows 的 ssh 调 askpass 时只传提示语、不带 `--askpass` 参数，结果每次都把整个 GUI 又启一遍、密码永远送不到，ssh 一直等。现在改成看环境变量 `NIFECODE_ASKPASS` 判断
3. **失败会重试两遍** → 通道失败后回落成一次性 ssh，等于把认证又走一遍（慢一倍，还可能触发服务器 fail2ban）。现在认证类错误（`Permission denied` / host key）直接返回，而且 `NumberOfPasswordPrompts=1`

超时也都设了：`ConnectTimeout=8`、`ServerAliveInterval=5`×3、前端 20 秒兜底。
- 私钥路径填了就用 `-i`，留空走 ssh-agent / 默认密钥

### 密码怎么存的

- 密码写进 **Windows 凭据管理器**（`keyring` crate，底层 DPAPI，只有你这个 Windows 用户能解），**不进 localStorage**
- 档案里只留一个 `pw: true` 标记，列表里显示 🔑
- 有密码时 ssh 不用 `BatchMode`，改成 `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force`，把**本程序自己当 askpass 助手**（`nifecode.exe --askpass` 会把密码打到 stdout）——文件读写、git、搜索、终端、端口转发全都自动填
- 删除档案会同时删掉凭据；密码框留空表示"保持不变"

### 密钥放在哪

用 Windows 自己的 `~/.ssh/`（和 VS Code Remote-SSH 一样）：

- profile 里主机可以直接填 `~/.ssh/config` 的 Host 别名（例如 `rn`），用户/端口/私钥全由 config 决定
- 不想写 config 就在"私钥路径"里填 Windows 路径，会加 `-i`
- `ProxyCommand` / `ProxyJump` 也能用（因为走的是系统 ssh）

用的是**本机 OpenSSH 客户端**，所以你 `~/.ssh/config` 里的 `ProxyJump`、`IdentityFile` 等配置会被继承。

| 用途 | 认证方式 |
|---|---|
| 文件读写 / git（`BatchMode=yes`） | 只能用密钥 / ssh-agent |
| 终端里的 `ssh` 会话 | 交互式，**密码也可以** |

- 远端文件读写走 `base64` / `cat`，需要远端有基础 POSIX 工具
- 远端 mtime 精度是秒级，同一秒内的二次外部改动可能检测不到
- 连上 SSH 后新开的终端会自动 `ssh -t` 过去，并 `cd` 到当前工作区

## Git

左侧 ⎇ 打开源代码管理面板：

- 顶部：当前分支 + 变更数量，`⟳` 手动刷新（面板可见时每 4s 自动刷新）
- 列表：`M` 修改 / `U` 未跟踪 / `A` 新增 / `D` 删除 / `R` 重命名
- 点文件 → 编辑器打开；点 `⇄` → 和 `HEAD` 的左右对比（只读，没有"应用"按钮）
- 底部：提交信息 → `提交全部更改`（等价 `git add -A && git commit -m`）

**本地和 SSH 都支持**：本地跑 `git -C <cwd>`，远端跑 `cd <cwd> && git ...`，共用一套解析。
`git_info` 只 spawn 一次 git（`status --porcelain=v1 -z -uall --branch` 同时给分支和变更），因为 Windows 上每次 spawn 约 200ms，冷启动更慢——打开工作区时会先在后台预热一次。

## 性能：git / ssh 怎么调

热点路径都做过实测（这是一台 Windows 机器，仓库约 1k 个文件）：

| 方案 | 单次耗时 | 结论 |
|---|---|---|
| spawn `git status --porcelain -z --branch` | **37.8ms** | 每次一个进程，太贵 |
| libgit2（`git2`）每次 open | 3.3ms | |
| libgit2 复用 Repository | **0.84ms** | 采用（本地 git 状态） |
| `stat_file` × N（每个文件一次调用） | N × 1ms | 改成批量 |
| `stat_files`（一次拿 N 个） | **1ms** | 采用 |
| `ssh` 每次操作一个进程 | 3.0s（237ms RTT 的服务器，含握手） | 往返已合并到最少 |
| libssh2（`ssh2`）常驻连接 | <1ms | 见下方取舍，暂未采用 |

**现在这样做的：**

- **本地 git 状态** → `git2`（libgit2，进程内，无 spawn）
- **远端 git** → 走 ssh 上的 `git` CLI（那边贵的是网络不是进程）
- **git 提交 / diff 取旧版本** → 保留 CLI（低频操作，且保留 hooks、签名、clean filter 等完整语义）
- **外部改动检测** → 一次 `stat_files` 批量拿所有打开文件的 mtime，不再每个文件一发
- **ssh 常驻通道** → 一条 `ssh -T host bash` 复用所有命令（见「远端性能」一节），约 12 倍提速
- **减少往返** → 远端打开文件合并成 1 条命令（大小+mtime+内容），保存也合并成 1 条

**为什么没整体换成 libssh2 / russh：**

`ssh2`（libssh2 绑定）和 `russh`（纯 Rust）都能常驻连接、每操作 <1ms，但会丢掉系统 `ssh` 免费给你的东西：`~/.ssh/config` 的 Host 别名、`ProxyJump`、known_hosts 校验、Windows 的 ssh-agent 集成。对"自己用的编辑器"来说这些都是刚需，所以选择保留 CLI + 连接复用。

> 冷启动注意：本会话第一次跑外部命令（git/ssh）会被系统扫描一遍，可能多花 3~5 秒，之后恢复正常。所以打开工作区时会在后台预热一次 git。

## 远程 GPU 服务器上这么用

```
1. 🔌 填 user@gpu-box（或 ~/.ssh/config 里的别名），连上后左边的树就是远端
2. ＋ 打开 ~/code/project，命令行里点 ＋ 开终端 —— 终端会 ssh -t 过去并 cd 到项目目录
3. 在终端里 python train.py / tail -f log 随便跑
4. 命令面板（Ctrl+Shift+P）→ 端口转发：本地 8888 → 127.0.0.1:8888，然后浏览器开 http://127.0.0.1:8888
5. 🔍 搜代码，点结果跳到那一行；改完 Ctrl+S 直接写回远端
```

远端链路的几个针对性处理：

- 外部改动轮询在 SSH 模式下从 1.2s 降到 **3s**，窗口不可见时不轮询
- 一次 `stat_files` 拿全部打开文件的 mtime（一条远端命令），不再每个文件一发
- 单文件打开上限 **8MB**（远端先 `stat -c %s` 问大小，超了直接拒绝，不会白传一遍）
- git 状态在远端走一条 `git status --porcelain -z --branch`

### 远端性能：一条常驻通道

远端不装任何东西，但也不再"每个操作起一个 ssh"。连上后后台开一条 `ssh -T <host> bash`，之后的命令都写进它的 stdin、结果从 stdout 读回来（base64 + 标记行分帧，协议在 `src-tauri/src/session.rs`）。

实测（237ms RTT 的服务器）：

| 操作 | 每次新开 ssh | 常驻通道 |
|---|---|---|
| 连接（一次性，含开通道） | — | 2.2s |
| 列目录 | 3.0s | **0.25s** |
| 打开文件 | 3.1s | **0.26s** |
| 保存 | 3.2s | **0.24s** |
| 搜索 | ~3.0s | **0.26s** |

约 **12 倍**。3 秒基本全是 TCP + KEX + 密钥认证（一次握手约 10 个往返），常驻通道把这部分付一次就完了。

几个实现上的细节：

- 命令必须是**单行**（远端是 `bash` 逐行读 stdin），所以在生成命令时就把换行换成了空格
- 输出统一 `base64 -w0`，靠 `NIFEB/NIFER/NIFEE` 三行标记分帧，二进制也安全
- 用 `${PIPESTATUS[0]}` 拿真实退出码，不是 `base64` 的
- 写入文件不再单开 ssh + stdin 管道：内容 base64 后跟命令一起走通道
- 通道断了自动丢弃，下次自动重开（并回落到一次性 ssh）
- `Host rn` 这种别名、`ProxyCommand`、known_hosts 全部照旧，因为底层还是系统 `ssh`

> Windows 上 OpenSSH 的 `ControlMaster` 试过，**不可用**（`mux_client_request_session: Connection reset by peer`，且只从 3.0s 降到 2.2s），已默认关闭。

## Agent Bridge

编辑器启动时在 `127.0.0.1:7317` 起一个 HTTP 服务。任何 agent（Nife、脚本、MCP 桥接）都能调：

```bash
# 打开文件并跳到第 42 行
curl -X POST -H "Content-Type: application/json" \
  -d '{"path":"D:/proj/src/main.ts","line":42}' \
  http://127.0.0.1:7317/open

# 打开工作区（目录）
curl -X POST -H "Content-Type: application/json" \
  -d '{"path":"D:/proj"}' http://127.0.0.1:7317/workspace

# 给出一份修改方案，让人在 diff 里点"应用/取消"
curl -X POST -H "Content-Type: application/json" \
  -d '{"path":"D:/proj/src/main.ts","newContent":"...新全文..."}' \
  http://127.0.0.1:7317/diff

# 读当前状态（打开的文件、脏文件、光标、最后一次 JS 错误）
curl http://127.0.0.1:7317/state
```

注意：Windows 的 bash 里 JSON 反斜杠容易被吃掉，路径一律用 `/`。

`/state` 返回示例：

```json
{"root":"D:/proj","host":null,"file":"D:/proj/src/main.ts","dirty":[],"selection":null,"lastError":null}
```

## 上下文标签（本机 / SSH）

窗口顶部一排标签，每个标签是一套独立的"工作上下文"：

```
[NifeCode ✕] [a_new_project ✕] [SSH · rn (GPU) ✕] [＋]
```

- **每个本机标签可以开不同的文件夹**（相当于 VS Code 开多个窗口，但只占一个进程）
- ＋ 新建一个本机标签并立刻弹文件夹选择；取消了就不留空标签
- 标签名就是文件夹名，鼠标悬停看完整路径
- 本机标签会存到 localStorage，**重启自动恢复**（连同目录）
- 每个 SSH 连接一个标签，点一下就切过去；**切回本机不用断开**
- 每个标签有自己的：工作区根目录、文件树、git 面板、搜索范围、状态栏
- 编辑器标签页是**共享的**：本机的 README 和远端的 .bashrc 可以同时开着
- 每个文档记住自己来自哪台机器（`Doc.host`），所以**在 SSH 标签下保存本机文件，还是写本地**，不会串
- 外部改动轮询按"来自哪台机器"分组，每组一次 `stat_files`
- `✕` 断开该连接并关掉标签；`＋` 打开 SSH 面板新建连接
- 终端不受影响：每个终端在创建时就绑定了当时的机器

## 文件图标

资源管理器里的图标是**自己画的 16px 线性 SVG**（`src/icons.ts`，15 个字形 + 每种类型一个颜色），不引图标字体、不加载图片、不用 emoji。

| 字形 | 用于 |
|---|---|
| 文件夹（实心） | 目录，展开后换成开口的 |
| `<>` | 代码：py / ts / js / rs / go / c / java / html / vue |
| `{}` | json / yaml |
| 齿轮 | toml / ini / conf，以及识别不了的点文件 |
| `>_` | sh / bash / zsh / ps1 |
| `#` | css / scss |
| 书 | md / rst（README 也是） |
| 图片 / 盒子 / 锁 / 钥匙 | 图片 / 压缩包 / .lock / .pem .key |
| 圆柱 / 立方体 / 网格本 | 数据库 / .pt .pth .onnx 权重 / .ipynb |
| 分支 | .gitignore / .gitattributes |
| 空白页 | 其它 |

颜色按语言区分（ts 蓝、js 黄、rs 橙、py 深蓝、md 蓝、图片紫、压缩包橙…），一眼能看出是哪种文件。

## 布局

```
┌────┬──────────┬──────────────┬──────────────┐
│活动│ 文件管理  │    编辑器     │    终端列     │
│ 栏 │  (260px) │    (自适应)   │ (420px, 可拖) │
└────┴──────────┴──────────────┴──────────────┘
│                状态栏                        │
```

终端列内部：

```
#term-col
├─ .head          终端 | ＋(当前页加终端) | ✕(收起)
├─ #term-tabs     页 1 ✕ | 页 2 ✕ | ＋(新建一页)
└─ #terms
   ├─ .term-page[data 页1]   ← 页内的终端垂直堆叠，不显示时整页 display:none
   └─ .term-page[data 页2]
```

页内终端高度：除最后一个外都是 `flex: 0 0 <px>`（拖横条改），最后一个 `flex: 1 1 0` 吃剩余空间；松手才 `fitAll()`，拖动过程中不重排 PTY。

三栏宽度是 CSS 变量 `--side-w` / `--term-w`（grid 头两个固定列 + `1fr` 编辑器），拖动 `#side-splitter` / `#term-splitter` 改，mouseup 时写 localStorage。

## 目录

```
src/               前端（vanilla TS + Monaco + xterm）
  main.ts          外壳：文件树、标签页、弹窗、状态栏、bridge 监听
  editor.ts        Monaco 封装（模型/脏标记/语言识别）
  terminal.ts      xterm.js ↔ PTY
src-tauri/src/
  fsops.rs         本地 / SSH 统一文件读写（read_dir/read_file/write_file/stat_file）
  session.rs       常驻 ssh 执行通道（一次握手，后续每个操作 ~1 个往返）
  proc.rs          spawn 外部程序时隐藏控制台窗口
  fwd.rs           端口转发（ssh -N -L）
  pty.rs           本地 PTY 终端
  bridge.rs        Agent Bridge HTTP 服务
scripts/           图标生成、CDP 截图与执行
```

## TODO

- [ ] **清理缓存功能**：加个命令（命令面板 / 状态栏菜单），一键清掉 WebView2 生成的可再生缓存，腾出磁盘。
  实测 `%LOCALAPPDATA%\dev.nife.code\EBWebView` 会涨到 161 MB / 831 个文件，其中约 93 MB 是纯缓存：

  | 目录 | 大小 | 处理 |
  |---|---|---|
  | `Default/Code Cache` | 61 MB | 删，Monaco 编译结果，下次自动重建 |
  | `Default/Cache` | 30 MB | 删，HTTP 缓存 |
  | `WidevineCdm` | 22 MB | 删，DRM 解码器，用不到 |
  | `component_crx_cache` | 22 MB | 删，Chromium 组件包 |
  | `Subresource Filter` | 13 MB | 删，广告过滤列表 |
  | `GPUCache` `Dawn*Cache` | 2.7 MB | 删 |
  | **`Local Storage`** | 几十 KB | **保留**——SSH 连接档案、打开的文件夹标签、窗口宽度都在这 |

  要点：只能删缓存目录，不能整个删 profile（否则用户的 SSH 档案全丢）；删完不用重启，下次启动自动重建。
- [ ] 退出时可选"清空缓存"开关（想做成真正绿色版的话）

## 已知限制 / 下一步

- 没有 LSP（补全/跳转定义）；TS 语义校验已关闭，避免满屏假红
- 没有扩展系统
- Git 面板只能"全量暂存"：没有单文件暂存、没有分支切换/拉取/推送、没有冲突解决
- Git 的 diff 是基于 `HEAD:./路径` 的整文件对比，不做行级 patch
- 远端文件是"整文件读写"，超过 8MB 直接拒绝打开（要看得先下载或本地开）
- 搜索跳过 `.git / node_modules / target / dist / build` 和 >2MB 的文件，不做正则
- Bridge 还没鉴权，因为只监听 127.0.0.1；若将来做远程在线编辑必须加 Token + TLS
