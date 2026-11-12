// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE

// monaco 的内部模块不带类型声明。只用了 markdownRenderer 一处，按实际用到的字段写死，
// 这样不用为了一个 markdown 解析再拉 marked + dompurify 两个依赖进来。
declare module "monaco-editor/esm/vs/base/browser/markdownRenderer.js" {
  export function renderMarkdown(
    markdown: {
      value: string;
      isTrusted?: boolean;
      supportHtml?: boolean;
      supportThemeIcons?: boolean;
      baseUri?: unknown;
    },
    options?: {
      actionHandler?: { callback(href: string, event: unknown): void; disposables: { add(disposable: unknown): unknown } };
      asyncRenderCallback?: () => void;
      fillInIncompleteTokens?: boolean;
      sanitizerOptions?: unknown;
      remoteImageIsAllowed?: (uri: unknown) => boolean;
      codeBlockRendererSync?: (lang: string, value: string) => HTMLElement;
    },
    markedOptions?: Record<string, unknown>
  ): { element: HTMLElement; dispose(): void };
}
