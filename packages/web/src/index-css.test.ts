import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  path.resolve(import.meta.dirname, "index.css"),
  "utf8"
);

/** `start` の直後の `{` から対応する `}` までの中身を返す */
function blockAfter(source: string, start: string): string {
  const at = source.indexOf(start);
  if (at < 0) throw new Error(`見つからない: ${start}`);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`閉じ括弧が無い: ${start}`);
}

function tokenNames(block: string): string[] {
  return [...block.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map(m => m[1]).sort();
}

describe("index.css のトークン", () => {
  const light = blockAfter(css, ":root");
  // `@custom-variant dark (@media (prefers-color-scheme: dark));` と取り違えないよう、波括弧まで含めて探す
  const dark = blockAfter(
    blockAfter(css, "@media (prefers-color-scheme: dark) {"),
    ":root"
  );

  it("ダークはOSの設定のメディアクエリで切り替える", () => {
    expect(css).toContain(
      "@custom-variant dark (@media (prefers-color-scheme: dark));"
    );
    expect(css).not.toMatch(/(^|\s)\.dark\s*[{.,]/m);
  });

  it("ライトとダークで同じ名前のトークンを定義している", () => {
    expect(tokenNames(dark)).toEqual(tokenNames(light));
  });

  it("状態色・影・ガラスのトークンがある", () => {
    for (const name of [
      "--status-busy",
      "--status-idle",
      "--status-awaiting",
      "--status-error",
      "--status-neutral",
      "--elevation-card",
      "--glass",
    ]) {
      expect(tokenNames(light)).toContain(name);
    }
    expect(css).toContain("--color-status-awaiting: var(--status-awaiting);");
    expect(css).toContain("--shadow-card: var(--elevation-card);");
  });

  it("ターミナル風の装飾クラスを撤去している", () => {
    for (const removed of [
      "terminal-prompt",
      "--color-terminal-",
      "status-indicator",
      "pulse-glow",
      "glow-green",
      "glow-cyan",
      "pet-bounce",
      "heart-float",
      "level-up-flash",
      "--chart-",
    ]) {
      expect(css).not.toContain(removed);
    }
  });

  it("本文のフォントはトークン経由で指定する", () => {
    expect(css).not.toContain("font-family: Inter");
    expect(css).toContain("-apple-system");
  });
});
