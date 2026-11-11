// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
// 自检：src/main.ts 里的 cleanPath()（路径去重用的规范化）。
// 没有前端测试框架，直接从源码里抠出那个函数跑，改坏了这里会红。
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const fn = src.match(/function cleanPath[^]*?\n}\n/)[0];
const f = new Function(
  fn
    .replace(/\(p: string\): string/, "(p)")
    .replace(/_m, d: string/, "_m, d")
    .replace("const out: string[]", "const out") +
    "; return cleanPath;"
)();

const B = String.fromCharCode(92); // 反斜杠
const cases = [
  ["D:/a/b.ts", "D:/a/b.ts"],
  ["d:" + B + "a" + B + "b.ts", "D:/a/b.ts"], // 反斜杠 + 小写盘符
  ["D:/a/./b.ts", "D:/a/b.ts"],
  ["D:/a/x/../b.ts", "D:/a/b.ts"],
  ["D:/a//b.ts", "D:/a/b.ts"],
  ["D:/a/x/y/../../b.ts", "D:/a/b.ts"],
  ["D:/../b.ts", "D:/b.ts"], // 盘符上一级还是自己
  ["/home/u/../../etc/x", "/etc/x"], // 根上一级也是自己
  ["/a/b/", "/a/b"],
  ["//srv/share/x", "//srv/share/x"], // UNC 别被压成 /srv
  ["/", "/"],
  ["D:/", "D:"],
];

let bad = 0;
for (const [inp, want] of cases) {
  const got = f(inp);
  const ok = got === want;
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${JSON.stringify(inp)} -> ${JSON.stringify(got)}${ok ? "" : `  want ${JSON.stringify(want)}`}`);
}
if (bad) {
  console.error(`${bad} 个用例失败`);
  process.exit(1);
}
console.log("cleanPath 全部通过");
