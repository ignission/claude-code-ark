import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { isMermaidCodeClass } from "../lib/mermaid-block-utils";

// 配線の要を検証する: SplitChatPane は react-markdown の code 分岐で
// isMermaidCodeClass(className) を見て MermaidBlock に振る。よって
// 「react-markdown が ```mermaid を language-mermaid として渡すか」が成立しないと
// 機能全体が動かない。ここを本番非依存(node)で固定する。
// 注: MermaidBlock.tsx(JSX) は root vitest が React 非対応のため import しない。
function capturedClassNameFor(markdown: string): string | undefined {
  let captured: string | undefined;
  const components: Components = {
    code: ({ className }) => {
      captured = className;
      return null;
    },
  };
  renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins: [remarkGfm], components },
      markdown
    )
  );
  return captured;
}

describe("mermaid × react-markdown 配線", () => {
  it("```mermaid フェンスは language-mermaid 判定に当たる", () => {
    const cls = capturedClassNameFor("```mermaid\nflowchart LR\nA-->B\n```");
    expect(isMermaidCodeClass(cls)).toBe(true);
  });

  it("通常言語(ts)フェンスは mermaid 判定に当たらない", () => {
    const cls = capturedClassNameFor("```ts\nconst a = 1;\n```");
    expect(isMermaidCodeClass(cls)).toBe(false);
  });
});
