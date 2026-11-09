<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE -->

# 给 Agent 的操作说明（NifeCode）

NifeCode 是一个 GUI 编辑器，不是一个需要你去点按钮的应用。分工只有两条：

1. **改代码**：用你自己的文件工具直接改磁盘上的文件。NifeCode 会自动重载（没被编辑过的）缓冲区；如果那个文件在编辑器里有**未保存改动**，它会弹窗问用户，所以动手前先看 `/state.dirty`。
2. **给人看**：要把结果摆到人眼前时，调下面的 HTTP 接口让它打开文件、切工作区、或者展示一份 diff。

## 接口

基址 `http://127.0.0.1:7317`，只监听本机回环，没有鉴权，请求/响应都是 JSON。

| 方法 | 路径 | body | 作用 |
|---|---|---|---|
| GET | `/state` | — | 读编辑器当前状态 |
| POST | `/open` | `{"path":"D:/p/src/a.ts","line":42}` | 打开文件并跳到第 42 行（`line` 可省） |
| POST | `/workspace` | `{"path":"D:/p"}` | 把工作区切到这个目录（等于人点了「打开文件夹」） |
| POST | `/diff` | `{"path":"D:/p/src/a.ts","newContent":"…全文…"}` | 弹出左右对照 diff，**人点「应用」才落盘**，点「取消」不改任何东西 |
| POST | `/save` | `{}` 或 `{"path":"D:/p/src/a.ts"}` | 真的写盘：`{}` 存所有脏文件，带 `path` 只存那一个 |

成功返回 `{"ok":true}`，未知路径返回 404。

`/save` 是**同步**的：前端写完盘才回包，最多等 60 秒。

```json
{"ok":true,"saved":["D:/p/src/a.ts"],"errors":[]}
{"ok":false,"saved":[],"errors":[{"path":"D:/nope.ts","error":"没有打开这个文件"}]}
```

`GET /state` 返回示例：

```json
{"root":"D:/p","host":null,"file":"D:/p/src/a.ts","dirty":["D:/p/src/b.ts"],"selection":null,"lastError":null}
```

| 字段 | 含义 |
|---|---|
| `root` | 当前工作区根目录 |
| `host` | `null` = 本地；非 null 是 SSH 主机名，此时 `path` 要用**远端**路径（`/home/u/x.ts`） |
| `file` | 当前激活的标签，没开文件时为 `null` |
| `dirty` | 有未保存改动的文件列表 |
| `selection` | 当前选中的内容：`{"file","startLine","endLine","text"}`，没选东西时是 `null`；`text` 最多 4000 字 |
| `lastError` | 前端最后一次 JS 异常，排查用 |

NifeCode 的终端里会导出 `NIFECODE_TERM=1` / `NIFECODE_BRIDGE=http://127.0.0.1:7317` / `NIFECODE_ROOT=<工作区根>`
（ssh 终端没有，环境变量不跨主机）。从编辑器终端启动的 agent 可以直接信这三个值。

配套的 nife 扩展是 `git:github.com/OliverMao/nifecode-bridge`（`nife install` 装，不在本仓库）：每轮开始前探一下端口，
**编辑器在跑**才把接口用法和实时状态追加进系统提示，没启动就静默（所以不用把这些写进全局 `AGENTS.md`）。

**状态是前端每 2 秒推一次的快照**：`POST` 之后别马上读 `/state`，等 2～3 秒；也不要写得比每 2 秒还勤。

## 发请求

**优先用仓库自带的客户端**，下面这些坑它都替你处理好了（连不上时退出码非 0）：

```bash
node scripts/nife.mjs state                  # 读状态
node scripts/nife.mjs open src/main.ts:120   # 打开并跳到行（相对路径按工作区根算）
node scripts/nife.mjs save                   # 存所有脏文件（带路径就只存一个）
node scripts/nife.mjs diff src/a.ts new.txt  # 拿 new.txt 全文弹左右对照，等人点「应用」
```

手写 HTTP 也可以，但要注意：

```bash
# PowerShell 5.1 里 curl 是 Invoke-WebRequest 的别名，必须写 curl.exe
curl.exe -s http://127.0.0.1:7317/state

# body 里有中文/换行/引号时，写进临时文件再 --data-binary，别在命令行里拼
curl.exe -s -X POST -H "Content-Type: application/json" --data-binary @payload.json \
  http://127.0.0.1:7317/diff
```

- 路径**一律用 `/`**（`D:/p/a.ts`），反斜杠在 JSON 里要写 `\\`，极易出错
- 中文内容用 UTF-8 写临时文件，不要靠命令行转义
- `/diff` 的 `newContent` 是**整个文件的全文**，不是补丁；大文件（>2 MB）别走 diff，直接改文件
- 端口固定 `7317`；NifeCode 没启动或端口被占时连接会被拒绝，先确认编辑器在跑

## 推荐工作流

1. `GET /state` → 看 `root` 对不对、目标文件在不在 `dirty` 里
2. 用你自己的工具改文件（这是主要手段，接口只是展示层）
3. 改动小 → `POST /open` 把人带到改动行；改动大/跨文件/危险操作 → `POST /diff` 让人确认
4. 要保存直接 `POST /save`（会真写盘并告诉你成功与否）；跑测试仍然只能请人动手

## 现在没有的能力（别试着用）

- 没有终端控制（不能替你跑命令、读终端输出）
- 没有 LSP（补全/跳转定义/诊断都不可用）
- 不能读回「编辑器里未保存的内容」，`/state` 只有路径和 dirty 标记
- 只能本机访问，没有远程接口

## 典型对话

> 「帮我改完 `src/auth.ts` 里那个超时，然后让我看看 diff」
>
> Agent：读 `/state` → 直接改文件 → `POST /diff` 带新全文 → 用户在 diff 里点「应用」或在对话里让它重做。
