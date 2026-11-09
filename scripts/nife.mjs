// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
// 给 agent（和人）用的小客户端：省掉 Windows 上 curl 的别名/引号/编码坑。
// 用法：
//   node scripts/nife.mjs state                    当前状态（root / 打开的文件 / 脏文件 / 选中内容 / 光标）
//   node scripts/nife.mjs open src/main.ts:120     打开并跳到第 120 行（不写行号就只打开）
//   node scripts/nife.mjs save                     保存所有未保存的文件
//   node scripts/nife.mjs save src/main.ts         只保存这一个
//   node scripts/nife.mjs diff src/main.ts new.txt 拿 new.txt 的全文做左右对照，等人点「应用」
//   node scripts/nife.mjs workspace D:/p           切换工作区目录
const BASE = process.env.NIFE_BRIDGE ?? "http://127.0.0.1:7317";

const [cmd, ...args] = process.argv.slice(2);
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const usage = () => fail("用法: state | open <path>[:line] | save [path] | diff <path> <新内容文件> | workspace <dir>");

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    fail(`连不上 ${BASE}（NifeCode 没启动？）—— ${e.message}`);
  }
  const text = await res.text();
  // 存档/写盘失败时也让退出码非 0，脚本里能 if 判断
  if (!res.ok || text.includes('"ok":false')) process.exitCode = 1;
  console.log(text);
}

/** "src/a.ts:120" → {path, line}；Windows 盘符里的冒号不算分隔符 */
function splitLine(arg) {
  const m = /^(.*):(\d+)$/.exec(arg);
  return m ? { path: m[1], line: Number(m[2]) } : { path: arg };
}

switch (cmd) {
  case "state":
    await call("GET", "/state");
    break;
  case "open": {
    if (!args[0]) usage();
    await call("POST", "/open", splitLine(args[0]));
    break;
  }
  case "save":
    await call("POST", "/save", args[0] ? { path: args[0] } : {});
    break;
  case "workspace":
    if (!args[0]) usage();
    await call("POST", "/workspace", { path: args[0] });
    break;
  case "diff": {
    if (!args[0] || !args[1]) usage();
    const { readFileSync } = await import("node:fs");
    // 全文从文件读，避免命令行转义把换行/引号搞坏
    await call("POST", "/diff", { path: args[0], newContent: readFileSync(args[1], "utf8") });
    break;
  }
  default:
    usage();
}
