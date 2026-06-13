import { describe, expect, it } from "vitest";
import { splitTextWithUrls } from "./linkify";

describe("splitTextWithUrls", () => {
  it("URL を含まないテキストは 1 つの text セグメント", () => {
    expect(splitTextWithUrls("ただのテキスト")).toEqual([
      { type: "text", value: "ただのテキスト" },
    ]);
  });

  it("空文字は空配列", () => {
    expect(splitTextWithUrls("")).toEqual([]);
  });

  it("前後にテキストのある URL を分解する", () => {
    expect(splitTextWithUrls("詳細は https://example.com を参照")).toEqual([
      { type: "text", value: "詳細は " },
      { type: "url", value: "https://example.com" },
      { type: "text", value: " を参照" },
    ]);
  });

  it("文末の句読点は URL に含めない", () => {
    expect(splitTextWithUrls("see https://example.com.")).toEqual([
      { type: "text", value: "see " },
      { type: "url", value: "https://example.com" },
      { type: "text", value: "." },
    ]);
  });

  it("括弧で囲まれた URL の閉じ括弧は URL に含めない", () => {
    expect(splitTextWithUrls("(https://example.com)")).toEqual([
      { type: "text", value: "(" },
      { type: "url", value: "https://example.com" },
      { type: "text", value: ")" },
    ]);
  });

  it("URL 内に対応する括弧があれば閉じ括弧を保持する", () => {
    expect(
      splitTextWithUrls("https://ja.wikipedia.org/wiki/Foo_(bar)")
    ).toEqual([
      { type: "url", value: "https://ja.wikipedia.org/wiki/Foo_(bar)" },
    ]);
  });

  it("複数の URL を分解する", () => {
    expect(splitTextWithUrls("a https://x.com b http://y.org c")).toEqual([
      { type: "text", value: "a " },
      { type: "url", value: "https://x.com" },
      { type: "text", value: " b " },
      { type: "url", value: "http://y.org" },
      { type: "text", value: " c" },
    ]);
  });

  it("http も対象", () => {
    expect(splitTextWithUrls("http://localhost:4001/foo")).toEqual([
      { type: "url", value: "http://localhost:4001/foo" },
    ]);
  });

  it("ftp 等の非 http スキームはリンクにしない", () => {
    expect(splitTextWithUrls("ftp://example.com/file")).toEqual([
      { type: "text", value: "ftp://example.com/file" },
    ]);
  });

  it("ホスト部の無い壊れた URL はリンク化しない", () => {
    expect(splitTextWithUrls("http://. と http:// は無効")).toEqual([
      { type: "text", value: "http://. と http:// は無効" },
    ]);
  });

  it("localhost はホストにドットが無くてもリンク化する", () => {
    expect(splitTextWithUrls("http://localhost:4001/x")).toEqual([
      { type: "url", value: "http://localhost:4001/x" },
    ]);
  });

  it("クエリ・フラグメント付き URL をそのまま拾う", () => {
    expect(
      splitTextWithUrls("https://example.com/a?b=1&c=2#frag のように")
    ).toEqual([
      { type: "url", value: "https://example.com/a?b=1&c=2#frag" },
      { type: "text", value: " のように" },
    ]);
  });
});
