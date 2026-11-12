# NifeCode

轻量的 VS Code 兼容编辑器：Tauri 2 + Monaco（VS Code 的编辑器内核）+ 本地 PTY 终端 + SSH + Agent Bridge。

Windows 下 release 版常驻内存实测：**175MB**（编辑器 + 文件树 + 1 个终端）、**213MB**（再加到 3 个终端）；VS Code 同类场景通常 500MB+，界面/快捷键/主题/输入法与 VS Code 一致，菜单和提示全中文。

> dev 模式（`pnpm tauri dev`，Vite 未压缩 + HMR）内存会到 600~700MB，这是开发模式开销，不代表发布版。

## 现在能用的

- 打开本地文件夹，懒加载文件树
- Monaco 编辑：语法高亮、多光标、折叠、查找替换、minimap，`Ctrl+S` 保存（焦点在文件树/终端里也能存）
- **编码自动识别**：UTF-8 / GBK(GB18030) / 带 BOM 的 UTF-16 都能正确打开，**保存时按原编码写回**（GBK 的老 `.txt`、`.ini`、老工程不会因为另存一次就乱码）；状态栏右下角显示当前编码，点一下可以强制换编码重新读盘
- **换行符默认 LF**：文件里本来没 CR 就用 LF，新建文件、新敲的回车都是 LF（跟 Linux/远端一致）；打开本来就是 CRLF 的文件保持 CRLF，状态栏显示 `LF` / `CRLF`
- **关窗不丢改动**：右上角 ✕ 时如果有没保存的文件，会列出文件名让你选「全部保存并关闭 / 不保存 / 取消」
- **`Ctrl+P` 快速打开**：全项目文件名模糊匹配（`src/ed` 这种片段也行），上下键选、回车打开；远端机器用一条 `find` 拿清单，结果缓存在内存里，文件树一变就失效重取
- **自定义标题栏**（原生那圈已经去掉）：左边 logo + `NifeCode` 点开主菜单 —— 设置 / 关于 / 退出；空格处可拖动窗口、双击最大化/还原；右边是自绘的最小化 / 最大化 / 关闭（关闭悬停变红，有未保存文件会先问）
- **设置**（主菜单 → 设置）：界面字号、编辑器 minimap、自动换行、默认换行符（LF/CRLF）、默认终端 shell、关窗是否确认未保存、**WebView 缓存占用与一键清理**、崩溃后是否恢复内容；改完立刻生效，存在本机
- **关于**（主菜单 → 关于）：macOS 风格的版本窗（图标 / 名称 / 版本号 / 仓库地址，点地址复制），版本号取自 `tauri.conf.json`
- **主题色统一**：强调色全部是品牌紫（`--accent` `#6d4a94`、选中行 `#3a2450`、状态栏 `#452760`），不再有零散的蓝色
- 标签页 + 未保存标记（`●`）；**标签右键菜单**：关闭 / 关闭其他 / 关闭右侧 / 关闭已保存 / 全部关闭 / 复制路径 / 复制相对路径 / 在资源管理器中显示；鼠标**中键**点标签直接关掉。标签多到装不下时**滚轮直接在标签栏上横向滚**，切换标签也会自动滚到可见处。关掉当前标签会自动切到邻居，不会留一个空编辑器
- 左侧活动栏、文件图标、状态全用**自绘 SVG**（`src/icons.ts`），不用 emoji、不引图标字体
- **资源管理器会自己刷新**：只 stat 当前根目录 + 已展开的目录，变了才重画（本地 1.5s / 远端 5s 一次），展开状态保留
- **悬停看全名**：文件名/路径被截断时，悬停 0.35 秒弹出完整路径（没截断就不打扰）；编辑器标签同理
- **右键菜单**：新建文件 / 新建文件夹 / 粘贴 / 打开 / 在此打开工作区 / **复制绝对路径** / **复制相对路径** / 复制 / 剪切 / 重命名 / 删除 / **在终端中打开** / **在资源管理器中显示**（后两项只有本机有，远端自动隐藏）。剪贴板记着来源机器，本地文件不会粘到远端去；`/` 和盘符根目录有保护，不会误删。文件树空白处右键可复制工作区路径
- **三栏布局**：文件管理 ｜ 编辑器 ｜ 终端，**三条边界都能拖**（侧栏 150~700px，终端 240px 起），宽度存 localStorage，重启保留
- **终端列分页**：一页 = 一组互相独立的终端（标签栏一个页签 = 一页）。面板头只有三个按钮：`＋` 新建一页、`˅` 在**当前页**新建终端（展开选类型：PowerShell / cmd / Git Bash / WSL）、`✕` 收起终端列。页内终端上下堆叠，**终端之间的横条可以拖**调各自高度；关掉页里最后一个终端会自动关掉这页
- 终端栏不会空着：启动就有 `页 1` + 一个 shell，关掉最后一页也立刻补一个
- 每个终端自己的标题条（`终端 1 · Windows PowerShell`）右侧有 `⊟` 拆分和 `✕` 关闭：拆分是**照抄这个终端的类型**在当前页再开一个，关闭只关这一个。标题条常显，因为拆分按钮只在它上面
- **终端页改名**：双击页签（或双击终端自己的标题条）就地改名，回车保存、Esc 取消、清空回车退回自动名字（自动名字 = 第一个终端的 shell 名，重名自动加 `(2)`）
- **外部改动检测**：文件被别的程序（比如 agent）改动后自动重载；你有未保存改动时会弹窗让你选"用磁盘版本 / 保留我的"
- **本地终端**：`xterm.js` + 真实 PTY，支持中文、颜色、resize，可多开。终端里会带上 `NIFECODE_TERM=1`、`NIFECODE_BRIDGE=http://127.0.0.1:7317`、`NIFECODE_ROOT=<工作区根>`，跑在里面的 agent（比如 Nife）据此知道自己"在 NifeCode 里"，不用靠猜
- **字号可调**：`Ctrl+=` / `Ctrl+-` / `Ctrl+0`（10~28px）。编辑器（Monaco）、终端（xterm）和后界面文字（文件树、标签栏、状态栏、SSH/搜索/SCM 面板、右键菜单、弹窗）一起缩放，靠 CSS 变量 `--ui` 驱动，存 localStorage
- **终端类型可选**：终端栏的 `˅` 列出这台机器上能用的 shell —— PowerShell（默认）/ cmd / Git Bash / WSL 各发行版；选过的会记住，下次新建终端就用它。工作目录自动跟随当前工作区（WSL 里是 `/mnt/d/...`）
- **输入中文不闪**：三层原因逐个堵掉了 —— ① 终端自己的滚动条不占布局宽度；② `pty_resize` 加 80ms 去抖（列数变一次就够，别一帧抖好几次）；③ 终端容器用 `overflow: clip` 而不是 `hidden`：`hidden` 仍然是可滚动容器，输入法的组合文字长过终端右边缘时，Chromium 会自动把整块终端滚偏几十像素来"露出"它，看着就是闪一下（扯到 TUI 上就是整屏抖）
- **SSH**：连远端机器，浏览/编辑/保存远端文件；连上后点终端 `＋` 直接开远端 shell（走交互式 PTY，**密码登录在这里可用**）
- **全项目搜索**：左侧 🔍，本地进程内遍历（走 `ignore` 库，**`.gitignore` / `.ignore` 生效**，跟 ripgrep 同一个引擎），远端跑一条 `grep -rn`。
  结果按**文件分组**（文件名 + 命中数徽标），每行前面是行号、命中的词紫色高亮，点文件跳到第一处、点某行跳到那一行；顶部一行汇总「N 处匹配 · M 个文件」（超 200 处会标出已达上限）
- **全项目替换**：搜索框下面填“替换为”，点「全部替换」或回车；本地/远端都支持，**按每个文件自己的编码写回**（GBK 文件不会变成 UTF-8），改完把已经打开且没改动的编辑器重新读一遍
- **终端内查找**：终端里 `Ctrl+F` 弹出小查找条（`↑`/`↓`/Enter 下一个/Shift+Enter 上一个，Esc 关闭）；有不认识的高度限制就不会顶乱终端布局
- **图片预览**：点 `.png/.jpg/.gif/.webp/.bmp/.ico/.svg` 直接看图（带尺寸和 KB 数，本地/远端都行），不占编辑器标签；
  `Ctrl+滚轮`按鼠标位置缩放、`Ctrl+=` / `Ctrl+-` 按中心缩放（10%~1600%，下限=刚好铺满）
- **超大文件**：超过 8MB 也能打开，但**以只读方式**（状态栏会提示），避免一键把 100MB 日志拖进来卡死；96MB 以上才拒绝
- **Word / PowerPoint 真渲染**：点 `.docx` / `.pptx` 直接在编辑器区看原样排版（Word 的段落/表格/图片/页眉页脚、
  PPT 的每张幻灯片），本地和 SSH 远端都行。用的是 `docx-preview`(Apache-2.0) 和 `pptx-preview`(ISC)，
  **两个库都是按需 `import()`**：不开 office 文件一行都不加载，主包不受影响
  - 页面按真实宽度渲染 → 中栏放不下就按比例缩到刚好放下（换窗口大小会重新算），跟 Word 的"适应窗口"一样
  - **关预览即释放**：`viewer.destroy()` + 删 DOM + `useBase64URL` 不留 blob URL，反复开关同一份 pptx 实测不累积（1359→1356→1357 MB）
  - 代价：首次打开 pptx 后 ~20MB 常驻（那 1.2MB 库和它的运行时，文档内容不在里面）；docx 关掉直接回基线
  - 老版 `.doc` / `.ppt` 是二进制格式，只有系统程序能读 → 弹窗一键「用系统程序打开」
- **PDF 预览**：点 `.pdf` 直接用 WebView2 自带的阅读器看（页码/缩放/搜索/打印都在），本地和 SSH 远端都行（32MB 上限）；
  不引 pdf.js，右上角还留一个「用系统程序打开」的退路
- **Markdown 实时预览**：`.md` 文件状态栏点「预览」或 `Ctrl+Shift+V`，编辑区和渲染区左右分屏，停手 200ms 重排；
  切到别的文件/关标签时自动收起，滚动位置不会因为重排弹回顶部。解析和脱敏用的是 monaco 包里自带的 marked + DOMPurify
- **编辑器里的超链接**：`Ctrl+点击` 文本里的 `http(s)` 链接直接用系统浏览器打开（路由和终端里的 `Ctrl+点击` 同一个）
- **二进制文件**：像 VS Code 一样先弹一句「无法在编辑器中显示」，「取消」不开、「仍然打开」以**只读**方式摊开乱码，
  不会因为手滑保存把 exe/图片写坏。判断方式是开头 8KB 有 NUL 或控制字符超 10%（带 BOM 的 UTF-16 不算）
- **未保存内容能扛崩溃**：每秒级把没保存的内容快照到 localStorage，崩溃/断电/被强杀后再启动会问“要不要恢复这几个文件”；正常存盘或关标签后快照自动清掉
- **SSH 标签重启还原**：上次连着的机器和打开的远端目录都会恢复成标签（灰色“未连接”），点一下用保存的配置重连并回到原目录；没连上之前不会后台偷偷反复握手动它的文件
- **端口转发**：把 GPU 服务器上的 Jupyter / TensorBoard 映射到本地（命令面板 → 端口转发，或状态栏点转发标记停止）
- **源代码管理**：左侧 ⎇ 面板，显示分支、变更文件列表；点文件直接打开，`⇄` 和 HEAD 对比；底部填提交信息（`Ctrl+Enter`）一键 `add -A` + commit
- **Agent Bridge**：本地 HTTP 接口，让 agent 打开文件、给修改方案看 diff
- **资源管理器右键「用 NifeCode 打开」**：设置 → 系统集成里一键开/关（只写 `HKCU\Software\Classes`，不需要管理员）。
  选文件夹就把它当工作区，选文件就直接打开（顺便把它所在目录当工作区）；已经有窗口在跑时把路径转给那个窗口，不再开第二个实例。
  Win11 的新版右键菜单只认打包应用，这个条目在**「显示更多选项」**（`Shift+F10`）里。
  菜单里记的是**当前 exe 的完整路径**：移动/改名 exe 之后要关掉再开一次

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

### 测试

```bash
cd src-tauri && cargo test        # 后端：解析/主机指纹这些纯函数
node scripts/test-cleanpath.mjs   # 路径去重用的 cleanPath
# UI 冒烟测试：需要一个带远程调试端口的窗口
cd src-tauri/target/release && WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./nifecode.exe
node scripts/test-ui.mjs          # 选择器 / 文件树展开 / 去重 / 图片缩放 / 删除 / 拖拽
```

UI 测试会临时把工作区切到 `<repo>/.probe/ws`（gitignored）并自己造测试文件，跑完切回原来的工作区。

前提：Rust（MSVC 工具链）+ Node 18+ + WebView2（Win11 自带）。

## 打包 / 发布

`pnpm tauri build` 之后能出两个 Windows 产物：

| 产物 | 路径 | 说明 |
|---|---|---|
| 免安装单文件 | `src-tauri/target/release/nifecode.exe` | 双击就跑，不写注册表、不进开始菜单，放哪都行 |
| 安装包 | `src-tauri/target/release/bundle/nsis/NifeCode_0.1.5_x64-setup.exe` | NSIS，装到 `%LOCALAPPDATA%`，带开始菜单和卸载项 |

两个都**不需要额外文件**（前端已内嵌进 exe）。免安装版就是那个普通 release 二进制，改个名而已：

```bash
cp src-tauri/target/release/nifecode.exe NifeCode_0.1.5_x64_portable.exe
```

## 自动更新

启动 6 秒后静默查一次更新，也可以在「关于」里点**检查更新**手动查。发现新版会问一句，确认后：

1. `curl` 下载便携版 exe 到程序目录，校验字节数
2. 把**正在运行的** exe 改名成 `NifeCode.old.exe`（Windows 允许改名运行中的 exe，不能直接覆盖）
3. 下载好的 exe 落到原位置，spawn 新进程，旧进程退出
4. 新进程启动时顺手删掉 `NifeCode.old.exe`

不需要管理员权限，不需要签名私钥，**便携版也能自己更新**（这也是 Chrome / VS Code 同款招数）。程序目录不可写（比如装在 `Program Files`）时会明确报错让你手动下安装包。

没用 `tauri-plugin-updater`：那套只认 NSIS/MSI，要么弹安装器要么要求维护一对 minisign 密钥；单文件便携版用不上。

更新源默认是 `https://api.github.com/repos/OliverMao/NifeCode/releases/latest`，会取最新 Release 里名字含 `portable` 的 `.exe`。仓库已公开，匿名请求就能查；如果以后又转回私有（或想走自己的中转），用环境变量换地址：

```bash
NIFECODE_UPDATE_URL="https://某处/latest.json" ./nifecode.exe
```

`latest.json` 只需要 GitHub Release API 的那几个字段：

```json
{ "tag_name": "v0.1.5", "body": "更新说明", "assets": [
  { "name": "NifeCode_0.1.5_x64_portable.exe", "size": 17185000,
    "browser_download_url": "https://.../NifeCode_0.1.5_x64_portable.exe" } ] }
```

## 应用图标

紫色 `#452760` 圆角方块 + 中间一根白竖条，就两个元素。全部由 `scripts/make-icon.mjs` 用代码画，一次出 **16/24/32/48/64/128/256 七档**（每档 4 倍超采样再降采样，所以放大到 256 边缘也不糊），仓库里没有任何图片素材，也没引图标库。

```
node scripts/make-icon.mjs   # 改完重跑，再 pnpm tauri build 才会进 exe / 安装包
```

> 踩过的坑：ICO 的 32 位像素是 **BGRA** 顺序，按 RGB 写会让颜色完全变样（之前蓝紫被画成了橙棕）。

## 快捷键

| 键 | 作用 |
|---|---|
| `Ctrl+S` | 保存 |
| `Ctrl+=` / `Ctrl++` | 放大字号（10~28px，编辑器和终端 + 文件树、标签、状态栏一起变） |
| `Ctrl+-` | 缩小字号 |
| `Ctrl+0` | 字号复原（13px） |
| `Ctrl+P` | 快速打开文件（模糊匹配） |
| `Ctrl+W` | 关闭当前标签（有未保存改动会问） |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 切到下一个 / 上一个标签 |
| `Ctrl+1` … `Ctrl+9` | 跳到第 N 个标签 |
| `Ctrl+`` ` | 显示/隐藏终端列 |
| `Ctrl+Shift+P` | 命令面板（打开文件夹 / SSH / 终端 / 保存） |
| `Ctrl+Shift+V` | Markdown 文件开/关实时预览（分屏渲染；终端里的这个键仍然是粘贴） |
| `F2` | 重命名文件树里选中的那一项 |
| `Delete` | 删除文件树里选中的项（多选一起删，删前确认） |
| `Esc` | 关闭弹窗 |

`F2` / `Delete` 认的是「最后一次点的是文件树」，所以点开一个文件、焦点跑到编辑器之后照样能用；但在编辑器/终端/输入框里按 `Delete` 仍然是删字符（不会误删文件）。

终端里（xterm 自己不管剪贴板，这些是本项目加的）：

| 键 / 操作 | 作用 |
|---|---|
| `Ctrl+C` | **有选中文字就复制**（不会给终端发 `^C`）；没有选中就照旧发 `^C` 中断 |
| `Ctrl+Shift+C` | 强制复制选中内容 |
| `Ctrl+Shift+V` | 粘贴 |
| `Ctrl+F` | 在终端里查找（`↑`/`↓` 跳，Esc 关） |
| `Ctrl+点击` | 点输出里的**文件路径**直接打开（带 `:行号` 就跳过去，相对路径按工作区根算）、点 **URL** 用系统浏览器打开；普通单击不抢，选文本不会跳走 |
| 鼠标右键 | 有选中就复制，没选中就粘贴（跟 Windows Terminal 一样） |

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
- 私钥路径填了就用 `-i`，留空走 ssh-agent / 默认密钥。**私钥按「主机:端口」分开记**：
  同一个 IP 不同端口常常是端口转发出来的两台机器，各用各的 key，切项目、关标签都不会把另一台的钥匙顶掉
- 同一个 IP 换端口后若撞上 known_hosts 里的旧记录（机器重装/端口重新映射），ssh 会报
  `Host key verification failed` / `REMOTE HOST IDENTIFICATION HAS CHANGED` 直接拒连。
  这时 NifeCode 会问一句「删掉 `[host]:port` 这条记录后重连吗」——只删这一条（走 `ssh-keygen -R`，hashed 的也能删），
  连上去自动记新密钥（`StrictHostKeyChecking=accept-new`）

### 连上之后换目录

SSH 上下文的资源管理器 `＋` 会弹一个**远端目录浏览器**（不是本地文件对话框）：

- 顶部是路径输入框，直接敲 `/workspace/xxx` 回车就跳过去
- 下面是子文件夹列表，点进去、`↰..` 回上一级
- 「打开」把当前目录设为工作区（也可以右键树里的某个文件夹 →「在此打开工作区」）
- 连上时默认还是用户的 `$HOME`

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

- 顶部：**仓库下拉 + 当前分支 + 变更数量**，`⟳` 手动刷新（面板可见时每 4s 自动刷新）
  - 下拉里是工作区根目录（它本身是仓库时）和它下面三层内的所有 git 仓库，深度优先、跳过 `node_modules / target / dist / build` 这类目录。
    **工作区根不是仓库、只有子文件夹是**的常见情况（一个文件夹里放好几个项目）直接选子文件夹就行，选中的那个记在项目标签里，重开还在
  - 列表里的路径是相对选中仓库的，`⇄` 对比和提交也都在这仓库里做
- 列表：`M` 修改 / `U` 未跟踪 / `A` 新增 / `D` 删除 / `R` 重命名
- 点文件 → 编辑器打开；点 `⇄` → 和 `HEAD` 的左右对比，**在标签栏里单独开一个 `⇄` 标签**（不是浮层，和文件标签同级）：
  左边 `HEAD`、右边工作区，只读；同一个文件再点一次是复用这个标签，✕ / 中键关掉就回到原来的文件标签
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

用 Nife 的话不用手写 curl，仓库里带了个小客户端（相对路径按工作区根算、编码和引号都处理好、失败退出码非 0）：

```bash
node scripts/nife.mjs state                  # root / 当前文件 / 脏文件 / 选中内容 / 光标
node scripts/nife.mjs open src/main.ts:120   # 打开并跳到第 120 行
node scripts/nife.mjs save                   # 保存所有未保存的文件（带路径就只存一个）
node scripts/nife.mjs diff src/a.ts new.txt  # 拿 new.txt 全文弹左右对照，等人点「应用」
```

要让 Nife **自动**知道这些，装扩展 `~/.nife/agent/extensions/nifecode-bridge.ts`：它在每轮开始前探一下
`127.0.0.1:7317`，**编辑器在跑**才把接口用法和实时状态（root / 当前文件 / 脏文件 / 选中内容 / 光标）追加进系统提示，
没启动就完全静默——不要写进全局 `AGENTS.md`，那会污染所有无关项目。

**给 agent 看的完整说明在 [AGENTS.md](AGENTS.md)**（接口表、`/state` 字段含义、PowerShell 的 `curl.exe` 坑、推荐工作流、以及哪些能力目前还没有）。把那个文件丢给 agent，或者直接让它读仓库根目录的 `AGENTS.md` 就行。

`/state` 返回示例：

```json
{"root":"D:/proj","host":null,"file":"D:/proj/src/main.ts","dirty":[],
 "selection":{"file":"D:/proj/src/main.ts","startLine":3,"endLine":9,"text":"…"},
 "cursor":{"file":"D:/proj/src/main.ts","line":12,"column":5},"lastError":null}
```

## 上下文标签（本机 / SSH）

窗口顶部一排标签，每个标签是一套独立的"工作上下文"：

```
[NifeCode ✕] [a_new_project ✕] [SSH · rn (GPU) ✕] [＋]
```

- **每个本机标签可以开不同的文件夹**（相当于 VS Code 开多个窗口，但只占一个进程）
- **编辑区跟着标签走**：每个项目 / 每个 SSH 连接各自一套打开的标签页、各自最后看的文件和滚动位置；
  切到别的项目就只看那个项目打开的文件，不会串台（底层还是一个 Monaco 实例，只是每套文档分开存）
- 关掉一个项目标签时，如果里面还有没保存的文件会先问「全部保存 / 不保存 / 取消」
- **长按项目标签 0.3 秒再往下拖 = 这个项目单开一个窗口**（同一个进程，第二套 JS 状态）：
  拖出来的窗口只有那一个项目、自己一套打开的标签页和终端，两边互不干扰；
  拖走时本窗口会把那个标签移出去（有未保存的文件先问「全部保存 / 不保存 / 取消」）
- **同一个项目只允许一个窗口开着**：再拖一次 / 再打开同一个文件夹 / 手动拖出去重复的那个窗口，
  都会直接把已经开着它的窗口顶到前面（新窗口自己关掉），不会出现两个窗口各开一份、互相触发"外部修改已重载"。
  路径比较会统一大小写和斜杠，`D:` 和 `D:/a/b/` 认成同一个；SSH 项目按「主机 + 路径」区分
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
scripts/           图标生成、CDP 截图与执行（make-icon.mjs 自绘图标，零素材）
```

## 许可证

**GNU 通用公共许可证第 3 版或更新版本（GPL-3.0-or-later）** —— 全文见 [LICENSE](LICENSE)，版权声明见 [COPYRIGHT](COPYRIGHT)。

> `LICENSE` 里是纯 GPL 正文（GitHub 靠它识别许可），版权/免责那几行单独放在 `COPYRIGHT`，两边内容不冲突。

自己用、公司内部用、改、二次发行都可以；但**发行修改版必须同样开源**（含你改的那部分），不能拿去做闭源分支。要闭源商用得单独找我授权（版权在我手上，可以双许可）。

### 为什么是这个

把 494 个 Rust crate 加前端依赖的许可全扫了一遍，结论是**依赖不限制我们选什么**：

| 依赖 | 许可 | 影响 |
|---|---|---|
| Tauri / tao / wry | `Apache-2.0 OR MIT` | Apache-2.0 与 GPLv3 兼容（**与 GPLv2 不兼容**，所以选 v3 不选 v2） |
| libgit2（`vendored-libgit2`） | `GPL-2.0 WITH linking exception` | 有链接例外，不会传染到我们的代码 |
| git2 / keyring / serde / base64 | `MIT OR Apache-2.0` | 随便选 |
| portable-pty / rfd | `MIT` | 随便选 |
| encoding_rs | `(Apache-2.0 OR MIT) AND BSD-3-Clause` | 保留声明即可 |
| ignore | `Unlicense OR MIT` | 随便选 |
| cssparser / selectors / option-ext | `MPL-2.0` | 文件级 copyleft，与 GPLv3 兼容 |
| Monaco / xterm.js | `MIT` | 随便选 |

既然依赖不逼我们，就按“严格”来：GPL-3.0 是桌面软件里最标准的强 copyleft，比 AGPL 合适（我们没有网络服务端，AGPL 只会吓跑使用者），比 MPL-2.0 严格（MPL 只覆盖被改的那几个文件，允许闭源整体）。

不选 MIT/Apache-2.0 的原因很直接：那样任何人都能拿这套代码做个闭源商业版，这跟“严格”相反。

### 用到了别人的东西

- 前端内嵌 Monaco（MIT）和 xterm.js（MIT），Rust 侧依赖见 `src-tauri/Cargo.lock`
- WebView2 是系统组件，随 Windows 提供，不随本项目分发
- 本项目的每个源文件头部都有 `SPDX-License-Identifier: GPL-3.0-or-later`

## TODO

- [x] **清理缓存功能**：设置里有一行「WebView 缓存」，显示当前占用，点「清理」只删可自动重建的缓存目录
  （`Default/Code Cache`、`Default/Cache`、`GPUCache`、`Dawn*Cache`、`component_crx_cache`、`Subresource Filter`、`WidevineCdm`、`Crashpad`），
  **`Local Storage` 一律不碰**（SSH 档案、工作区标签、窗口宽度、各项设置都在这）。实测 204 MB → 8.4 MB，不用重启。

## 已知限制 / 下一步

- 自动更新没有签名校验（项目本来就不签名），只校验下载字节数；文件来自 GitHub HTTPS

- 没有 LSP（补全/跳转定义）；TS 语义校验已关闭，避免满屏假红
- 没有扩展系统
- Git 面板只能"全量暂存"：没有单文件暂存、没有分支切换/拉取/推送、没有冲突解决
- Git 的 diff 是基于 `HEAD:./路径` 的整文件对比，不做行级 patch
- 远端文件是"整文件读写"，超过 8MB 直接拒绝打开（要看得先下载或本地开）
- 搜索跳过 `.git / node_modules / target / dist / build` 和 >2MB 的文件，不做正则
- Bridge 还没鉴权，因为只监听 127.0.0.1；若将来做远程在线编辑必须加 Token + TLS
