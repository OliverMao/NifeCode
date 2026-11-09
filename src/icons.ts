// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
// 16px 线性 SVG 图标集（自己画的，无外部资源）
export interface IconSpec {
  glyph: string;
  color: string;
}

type Glyph = { d?: string; fill?: boolean; extra?: string };

const GLYPH: Record<string, Glyph> = {
  folder: {
    fill: true,
    d: "M1.6 4c0-.6.5-1.1 1.1-1.1h3.1l1.6 2h5.9c.6 0 1.1.5 1.1 1.1v6.6c0 .6-.5 1.1-1.1 1.1H2.7c-.6 0-1.1-.5-1.1-1.1z",
  },
  folderOpen: {
    fill: true,
    d: "M1.6 13.2V4c0-.6.5-1.1 1.1-1.1h3.1l1.6 2h5.9c.6 0 1.1.5 1.1 1.1v1.2H5.5L3 13.2z",
    extra: '<path d="M3.9 14.1 5.8 7.9h9.1l-2.1 6.2z" opacity=".6"/>',
  },
  file: { d: "M4.2 1.9h4.4l3.2 3.2v8.9H4.2zM8.6 1.9v3.2h3.2" },
  code: { d: "M5.8 4.9 2.6 8l3.2 3.1M10.2 4.9 13.4 8l-3.2 3.1" },
  braces: {
    d:
      "M6.3 2.3c-1.35 0-1.45 1.6-1.45 2.6S4.6 7.7 3.3 8c1.3.3 1.55 1.2 1.55 2.2s.1 3.5 1.45 3.5" +
      "M9.7 2.3c1.35 0 1.45 1.6 1.45 2.6S11.4 7.7 12.7 8c-1.3.3-1.55 1.2-1.55 2.2s-.1 3.5-1.45 3.5",
  },
  terminal: { d: "M2.8 4.8 6.1 8l-3.3 3.2M7.8 11.4h5.4" },
  hash: { d: "M6.4 2.8 5.3 13.2M10.7 2.8 9.6 13.2M3 6h10.2M2.6 10h10.2" },
  image: {
    d: "M2.6 12.4V3.6h10.8v8.8zM2.6 10.8 6 7.4l2.9 2.9 1.7-1.7 2.8 2.8",
    extra: '<circle cx="10.3" cy="5.9" r=".9"/>',
  },
  box: { d: "M2.6 5.4h10.8v7.1H2.6zM2.6 5.4 4.2 2.6h7.6l1.6 2.8M8 5.4v7.1" },
  lock: { d: "M5.3 7V5.4a2.7 2.7 0 0 1 5.4 0V7M3.8 7h8.4v6.3H3.8z" },
  data: {
    d: "M3.5 4.5v7c0 1.05 2 1.9 4.5 1.9s4.5-.85 4.5-1.9v-7",
    extra: '<ellipse cx="8" cy="4.5" rx="4.5" ry="1.9"/>',
  },
  cube: { d: "M8 2.2 13.2 5v5.9L8 13.8 2.8 10.9V5zM2.8 5 8 7.9l5.2-2.9M8 7.9v5.9" },
  gear: {
    d: "M8 2.1v1.8M8 12.1v1.8M2.1 8h1.8M12.1 8h1.8M3.9 3.9l1.25 1.25M10.85 10.85l1.25 1.25M12.1 3.9 10.85 5.15M5.15 10.85 3.9 12.1",
    extra: '<circle cx="8" cy="8" r="2.35"/>',
  },
  book: {
    d:
      "M3.2 2.8h4.3c.8 0 1.4.6 1.4 1.4v9.2c0-.8-.6-1.4-1.4-1.4H3.2z" +
      "M12.8 2.8H8.5c-.8 0-1.4.6-1.4 1.4v9.2c0-.8.6-1.4 1.4-1.4h4.3z",
  },
  key: {
    d: "M7.5 8.6 13 14.1M11.1 12.2l1.4-1.4M9.3 10.4l1.4-1.4",
    extra: '<circle cx="5.5" cy="6.6" r="2.55"/>',
  },
  git: {
    d: "M4.5 5.4v5.2M11.4 8c0 2-1.4 3-3.4 3.6",
    extra:
      '<circle cx="4.5" cy="3.8" r="1.55"/><circle cx="4.5" cy="12.2" r="1.55"/><circle cx="11.4" cy="6.3" r="1.55"/>',
  },
  notebook: {
    d: "M5.9 6h4.2M5.9 8.6h4.2M5.9 11.2h2.6",
    extra: '<rect x="3.3" y="2.5" width="9.4" height="11" rx="1"/>',
  },
};

const BY_EXT: Record<string, [string, string]> = {
  py: ["code", "#4b8bbe"], pyi: ["code", "#4b8bbe"], ipynb: ["notebook", "#f37726"],
  ts: ["code", "#5596cf"], tsx: ["code", "#5596cf"], js: ["code", "#cbcb41"], jsx: ["code", "#cbcb41"],
  mjs: ["code", "#cbcb41"], cjs: ["code", "#cbcb41"], vue: ["code", "#41b883"], svelte: ["code", "#ff3e00"],
  rs: ["code", "#d9822b"], go: ["code", "#00acd7"],
  c: ["code", "#6b8fc4"], h: ["code", "#6b8fc4"], cpp: ["code", "#6b8fc4"], cc: ["code", "#6b8fc4"],
  hpp: ["code", "#6b8fc4"], java: ["code", "#cc3e44"], kt: ["code", "#a97bff"], rb: ["code", "#cc3e44"],
  json: ["braces", "#cbcb41"], yaml: ["braces", "#cbcb41"], yml: ["braces", "#cbcb41"],
  toml: ["gear", "#cbcb41"], ini: ["gear", "#cbcb41"], conf: ["gear", "#cbcb41"], cfg: ["gear", "#cbcb41"],
  properties: ["gear", "#cbcb41"],
  md: ["book", "#519aba"], markdown: ["book", "#519aba"], rst: ["book", "#519aba"],
  txt: ["file", "#8b949e"], log: ["file", "#8b949e"], pdf: ["file", "#cc3e44"],
  html: ["code", "#e37933"], htm: ["code", "#e37933"],
  css: ["hash", "#519aba"], scss: ["hash", "#a074c4"], less: ["hash", "#519aba"],
  sh: ["terminal", "#89e051"], bash: ["terminal", "#89e051"], zsh: ["terminal", "#89e051"],
  fish: ["terminal", "#89e051"], ps1: ["terminal", "#4f9fe0"], bat: ["terminal", "#8b949e"], cmd: ["terminal", "#8b949e"],
  png: ["image", "#a074c4"], jpg: ["image", "#a074c4"], jpeg: ["image", "#a074c4"], gif: ["image", "#a074c4"],
  webp: ["image", "#a074c4"], bmp: ["image", "#a074c4"], ico: ["image", "#ffb13b"], svg: ["image", "#ffb13b"],
  zip: ["box", "#cc8b3e"], tar: ["box", "#cc8b3e"], gz: ["box", "#cc8b3e"], tgz: ["box", "#cc8b3e"],
  xz: ["box", "#cc8b3e"], zst: ["box", "#cc8b3e"], whl: ["box", "#cc8b3e"], "7z": ["box", "#cc8b3e"],
  rar: ["box", "#cc8b3e"], msi: ["box", "#8b949e"], exe: ["box", "#8b949e"], deb: ["box", "#cc8b3e"],
  csv: ["data", "#4ec9b0"], xlsx: ["data", "#4ec9b0"], sql: ["data", "#4ec9b0"],
  db: ["data", "#4ec9b0"], sqlite: ["data", "#4ec9b0"],
  lock: ["lock", "#d4b34a"], env: ["key", "#d4b34a"], pem: ["key", "#d4b34a"], key: ["key", "#d4b34a"],
  crt: ["key", "#d4b34a"], pub: ["key", "#d4b34a"],
  pth: ["cube", "#a074c4"], pt: ["cube", "#a074c4"], ckpt: ["cube", "#a074c4"], onnx: ["cube", "#a074c4"],
  safetensors: ["cube", "#a074c4"], h5: ["cube", "#a074c4"], bin: ["cube", "#a074c4"],
};

// 整名匹配（小写），优先于扩展名
const BY_NAME: [string, [string, string]][] = [
  ["dockerfile", ["box", "#4b9fd5"]],
  ["makefile", ["gear", "#8b949e"]],
  ["cmakelists.txt", ["gear", "#8b949e"]],
  ["package.json", ["braces", "#cbcb41"]],
  ["cargo.toml", ["gear", "#d9822b"]],
  ["cargo.lock", ["lock", "#d4b34a"]],
  ["readme", ["book", "#519aba"]],
  ["license", ["file", "#8b949e"]],
  [".gitignore", ["git", "#f14e32"]],
  [".gitattributes", ["git", "#f14e32"]],
];

export function iconFor(name: string, isDir: boolean, open: boolean): IconSpec {
  if (isDir) return { glyph: open ? "folderOpen" : "folder", color: "#6f9dd0" };
  const n = name.toLowerCase();
  for (const [hit, spec] of BY_NAME) if (n.includes(hit)) return { glyph: spec[0], color: spec[1] };
  const dot = n.lastIndexOf(".");
  if (dot > 0) {
    const e = BY_EXT[n.slice(dot + 1)];
    if (e) return { glyph: e[0], color: e[1] };
  }
  return { glyph: n.startsWith(".") ? "gear" : "file", color: "#8b949e" };
}

export function iconSvg(spec: IconSpec): string {
  const g = GLYPH[spec.glyph] ?? GLYPH.file;
  const paint = g.fill
    ? `fill="${spec.color}" stroke="none"`
    : `fill="none" stroke="${spec.color}" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"`;
  const path = g.d ? `<path d="${g.d}"/>` : "";
  return `<svg viewBox="0 0 16 16" width="15" height="15" ${paint}>${g.extra ?? ""}${path}</svg>`;
}

// ---------- 左侧活动栏图标（24px，跟 VS Code 的 codicons 同一路子） ----------
const UI_GLYPH: Record<string, string> = {
  // 资源管理器：两张叠起来的纸
  explorer:
    '<path d="M13.8 3.2H7.2a1.4 1.4 0 0 0-1.4 1.4v12.2"/>' +
    '<rect x="9.4" y="6.6" width="10.2" height="13.2" rx="1.4"/>' +
    '<path d="M11.8 9.6h5.4M11.8 12.4h5.4M11.8 15.2h3.4"/>',
  // 搜索：放大镜
  search: '<circle cx="10.6" cy="10.6" r="5.6"/><path d="M14.8 14.8 20 20"/>',
  // 源代码管理：分支
  scm:
    '<circle cx="7" cy="4.8" r="2.1"/><circle cx="7" cy="19.2" r="2.1"/><circle cx="17.2" cy="9.2" r="2.1"/>' +
    '<path d="M7 6.9v10.2M17.2 11.3c0 3.3-2.3 5-5 5.8"/>',
  // SSH：插头
  ssh:
    '<path d="M9 2.8v4.6M15 2.8v4.6"/><path d="M6.4 7.4h11.2v3.2a5.6 5.6 0 0 1-11.2 0z"/>' +
    '<path d="M12 16.2v5"/>',
};

export function uiIcon(name: string): string {
  const d = UI_GLYPH[name];
  if (!d) return "";
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}

// ---------- 界面上的小按钮（＋ ✕ ˅），跟活动栏同一路子自己画 ----------
const CHROME: Record<string, string> = {
  plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
  close: '<path d="M4.1 4.1 11.9 11.9M11.9 4.1 4.1 11.9"/>',
  chevron: '<path d="M4.4 6.5 8 10.1l3.6-3.6"/>',
};

export function chromeIcon(name: string): string {
  const d = CHROME[name];
  if (!d) return "";
  return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}
