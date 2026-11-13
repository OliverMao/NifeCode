// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
// AI 行内补全（Copilot 式灰字）：提示词和结果清洗在这里，请求由 Rust 代发（网关不给 CORS）。
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import { invoke } from "@tauri-apps/api/core";

export interface AiCfg {
  on: boolean;
  exts: string;
  base: string;
  model: string;
}

/** 实测：不要求 JSON 时模型会把 `</file>` 这类框架标签当代码吐出来，清洗不掉；要 JSON 就干净了 */
const SYS =
  '你是代码补全引擎。返回 JSON：{"code":"光标处要插入的代码"}。' +
  "code 只含代码本身，不加 markdown 围栏、不重复光标前已有的内容；不需要补全时给空字符串。";

const DEBOUNCE = 250;
const MAX_LINES = 6;
const MAX_CHARS = 300;

// 网关不认 response_format / reasoning_effort 时降级成纯文本，本会话记住不再试
let plain = false;
let fails = 0;
let muteUntil = 0;

export function registerAi(cfg: () => AiCfg, onMsg: (m: string) => void) {
  // 选择器不能写 "*"（那是当语言 id 用的，永远匹配不上），用 pattern 匹配所有文档
  monaco.languages.registerInlineCompletionsProvider({ pattern: "**" }, {
    async provideInlineCompletions(model, position, _ctx, token) {
      const c = cfg();
      if (!c.on || !c.base.trim() || !c.model.trim()) return null;
      const path = model.uri.path.toLowerCase();
      if (!extsOf(c.exts).some((e) => path.endsWith(e))) return null;
      if (model.getValueLength() > 2_000_000) return null;
      if (Date.now() < muteUntil) return null;
      // 注释行没什么好续的，省一半请求
      const lead = model
        .getLineContent(position.lineNumber)
        .slice(0, position.column - 1)
        .trimStart();
      if (/^(\/\/|#|\*|--|<!--)/.test(lead)) return null;

      await new Promise((r) => setTimeout(r, DEBOUNCE));
      if (token.isCancellationRequested) return null;

      let code: string;
      try {
        code = clean(await ask(model, position, c), beforeOf(model, position));
        fails = 0;
      } catch (err) {
        // 连续失败就静一会儿，别每次按键都去撞一个挂掉的接口
        if (++fails >= 3) muteUntil = Date.now() + 30_000;
        if (fails === 1) onMsg(`AI 补全失败：${err}`);
        return null;
      }
      if (!code) return null;
      const pos = new monaco.Position(position.lineNumber, position.column);
      return {
        items: [{ insertText: code, range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column) }],
      };
    },
    freeInlineCompletions() {},
  });
}

function extsOf(list: string): string[] {
  return list
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((e) => (e.startsWith(".") ? e : `.${e}`));
}

function beforeOf(model: monaco.editor.ITextModel, position: monaco.Position) {
  return model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, position.column));
}

async function ask(model: monaco.editor.ITextModel, position: monaco.Position, c: AiCfg): Promise<string> {
  const offset = model.getOffsetAt(position);
  const all = model.getValue();
  const before = all.slice(Math.max(0, offset - 1400), offset);
  // 文件头给类型和命名风格，光标前给主要依据，光标后防止补出重复代码
  const head = offset > 1400 ? `${all.slice(0, 1000)}\n…\n` : "";
  const prompt =
    `<file path="${model.uri.path}" lang="${model.getLanguageId()}">\n` +
    `<before>\n${head}${before}\n</before>\n<after>\n${all.slice(offset, offset + 400)}\n</after>`;

  const body: Record<string, unknown> = {
    model: c.model,
    temperature: 0,
    max_tokens: MAX_LINES * 40,
    stream: false,
    reasoning_effort: "none", // 不关思考要 1.3s，而且 content 是空的
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYS },
      { role: "user", content: prompt },
    ],
  };
  if (plain) {
    delete body.reasoning_effort;
    delete body.response_format;
  }
  const url = `${c.base.replace(/\/+$/, "")}/chat/completions`;
  let raw: string;
  try {
    raw = await invoke<string>("ai_post", { url, body: JSON.stringify(body) });
  } catch (err) {
    // 400 / 不认字段：退回纯文本续写再试一次
    if (!plain && /HTTP 4\d\d/.test(String(err))) {
      plain = true;
      return ask(model, position, c);
    }
    throw err;
  }
  const content = JSON.parse(raw)?.choices?.[0]?.message?.content ?? "";
  try {
    return String(JSON.parse(content)?.code ?? "");
  } catch {
    return String(content); // 降级成纯文本时 content 就是代码
  }
}

/** 去围栏、去和光标前重复的那一段、只留完整的行 */
function clean(raw: string, before: string): string {
  let s = raw.replace(/\r/g, "").replace(/^\s*```[\w-]*\n?|```\s*$/g, "").replace(/^\n+/, "").trimEnd();
  for (let n = Math.min(before.length, s.length, 200); n > 3; n--) {
    if (s.startsWith(before.slice(-n))) {
      s = s.slice(n);
      break;
    }
  }
  if (!s) return "";
  // 被 max_tokens 截断的尾巴（"const x = " 这种）别插进去
  const i = s.lastIndexOf("\n");
  const last = i < 0 ? s : s.slice(i + 1);
  const open = (last.match(/\(/g)?.length ?? 0) > (last.match(/\)/g)?.length ?? 0);
  if (open || /[,+\-*/=&|<>(\[{:.\\]$/.test(last)) {
    if (i < 0) return "";
    s = s.slice(0, i);
  }
  return s.split("\n").slice(0, MAX_LINES).join("\n").slice(0, MAX_CHARS);
}
