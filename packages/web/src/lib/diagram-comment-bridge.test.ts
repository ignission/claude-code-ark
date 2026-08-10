import type { DiagramCommentsResponse } from "@ark/shared";
import { describe, expect, it } from "vitest";
import {
  parseDiagramCommentPortRequest,
  toDiagramCommentPortResult,
} from "./diagram-comment-bridge";

describe("parseDiagramCommentPortRequest", () => {
  it.each([
    [
      { type: "ark:diagram-comments-load", requestId: "req-load" },
      { type: "ark:diagram-comments-load", requestId: "req-load" },
    ],
    [
      {
        type: "ark:diagram-comment-create",
        requestId: "req-create",
        anchorId: "s1-p1",
        anchorQuote: "選択した本文",
        anchorOccurrence: 1,
        body: "本文",
      },
      {
        type: "ark:diagram-comment-create",
        requestId: "req-create",
        anchorId: "s1-p1",
        anchorQuote: "選択した本文",
        anchorOccurrence: 1,
        body: "本文",
      },
    ],
    [
      {
        type: "ark:diagram-comment-create",
        requestId: "req-create-first",
        anchorId: "s1-p1",
        anchorQuote: "先頭の一致",
        body: "本文",
      },
      {
        type: "ark:diagram-comment-create",
        requestId: "req-create-first",
        anchorId: "s1-p1",
        anchorQuote: "先頭の一致",
        body: "本文",
      },
    ],
    [
      {
        type: "ark:diagram-comment-resolve",
        requestId: "req-resolve",
        threadId: "th-1",
      },
      {
        type: "ark:diagram-comment-resolve",
        requestId: "req-resolve",
        threadId: "th-1",
      },
    ],
    [
      {
        type: "ark:diagram-comment-send",
        requestId: "req-send",
        threadId: "th-1",
      },
      {
        type: "ark:diagram-comment-send",
        requestId: "req-send",
        threadId: "th-1",
      },
    ],
  ])("valid request %j を narrow する", (input, expected) => {
    expect(parseDiagramCommentPortRequest(input)).toEqual({
      kind: "request",
      request: expected,
    });
  });

  it.each([
    [
      {
        type: "ark:diagram-comment-create",
        requestId: "req-anchor",
        anchorId: "",
        body: "本文",
      },
      "anchorId",
    ],
    [
      {
        type: "ark:diagram-comment-create",
        requestId: "req-body",
        anchorId: "s1",
        body: "\n\t",
      },
      "body",
    ],
    [
      {
        type: "ark:diagram-comment-create",
        requestId: "req-quote",
        anchorId: "s1",
        anchorQuote: "q".repeat(1001),
        body: "本文",
      },
      "anchorQuote",
    ],
  ])("検証失敗 %j を requestId 付き invalid にする", (input, field) => {
    const parsed = parseDiagramCommentPortRequest(input);

    expect(parsed).toMatchObject({
      kind: "invalid",
      requestId: input.requestId,
    });
    expect(parsed).toHaveProperty("error", expect.stringMatching(/不正|入力/));
    expect(parsed).toHaveProperty("error", expect.stringContaining(field));
  });

  it("author を含む create を未知フィールドとして invalid にする", () => {
    expect(
      parseDiagramCommentPortRequest({
        type: "ark:diagram-comment-create",
        requestId: "req-author",
        anchorId: "s1",
        author: "Reviewer",
        body: "本文",
      })
    ).toMatchObject({
      kind: "invalid",
      requestId: "req-author",
      error: expect.stringContaining("author"),
    });
  });

  it.each([
    {
      type: "ark:diagram-comments-load",
      requestId: "req",
      anchorId: "extra",
    },
    {
      type: "ark:diagram-comment-create",
      requestId: "req",
      anchorId: "a".repeat(257),
      body: "本文",
    },
    {
      type: "ark:diagram-comment-create",
      requestId: "req",
      anchorId: "s1",
      anchorOccurrence: 0,
      body: "本文",
    },
    {
      type: "ark:diagram-comment-create",
      requestId: "req",
      anchorId: "s1",
      anchorQuote: "本文",
      anchorOccurrence: -1,
      body: "本文",
    },
    {
      type: "ark:diagram-comment-create",
      requestId: "req",
      anchorId: "s1",
      anchorQuote: "本文",
      anchorOccurrence: 0,
      unknown: true,
      body: "本文",
    },
    {
      type: "ark:diagram-comment-create",
      requestId: "req",
      anchorId: "s1",
      body: "b".repeat(4001),
    },
    {
      type: "ark:diagram-comment-resolve",
      requestId: "req",
      threadId: null,
    },
    {
      type: "ark:diagram-comment-resolve",
      requestId: "req",
      threadId: "t".repeat(257),
    },
    {
      type: "ark:diagram-comment-send",
      requestId: "req",
      threadId: "th-1",
      body: "クライアントから文面を送らない",
    },
    {
      type: "ark:diagram-comment-send",
      requestId: "req",
      threadId: " ",
    },
  ])("その他の検証失敗 %j も invalid として返す", input => {
    expect(parseDiagramCommentPortRequest(input)).toMatchObject({
      kind: "invalid",
      requestId: "req",
      error: expect.any(String),
    });
  });

  it("不明なフィールド名は件数と長さを丸めてエラーへ含める", () => {
    const longKeys = ["a", "b", "c", "d", "e"].map(
      prefix => `${prefix}${"x".repeat(80)}`
    );
    const input: Record<string, unknown> = {
      type: "ark:diagram-comments-load",
      requestId: "req-unknown-keys",
    };
    for (const key of longKeys) input[key] = true;

    const parsed = parseDiagramCommentPortRequest(input);

    expect(parsed).toMatchObject({ kind: "invalid" });
    if (parsed.kind !== "invalid") throw new Error("invalid response expected");
    expect(parsed.error).toContain(`${longKeys[0].slice(0, 40)}…`);
    expect(parsed.error).not.toContain(longKeys[0]);
    expect(parsed.error).not.toContain(longKeys[3].slice(0, 40));
    expect(parsed.error).toContain("ほか 2 件");
    expect(parsed.error.length).toBeLessThan(180);
  });

  it.each([
    null,
    [],
    "request",
    {},
    { type: "unknown", requestId: "req" },
    { type: "ark:diagram-pinch", deltaY: 10 },
    { type: "ark:diagram-submit", model: {}, html: "<html></html>" },
    { type: "ark:diagram-comments-load" },
    { type: "ark:diagram-comments-load", requestId: 1 },
    { type: "ark:diagram-comments-load", requestId: "r".repeat(257) },
  ])("無関係または requestId 不正の %j を ignore する", input => {
    expect(parseDiagramCommentPortRequest(input)).toEqual({ kind: "ignore" });
  });
});

describe("toDiagramCommentPortResult", () => {
  it("success の requestId と snapshot を保持する", () => {
    const response: DiagramCommentsResponse = {
      ok: true,
      comments: {
        version: 1,
        target: "sample.diagram.html",
        threads: [],
      },
    };

    expect(toDiagramCommentPortResult("req-1", response)).toEqual({
      type: "ark:diagram-comments-result",
      requestId: "req-1",
      ok: true,
      comments: response.comments,
    });
  });

  it("error を空 snapshot にせず code/message 付きで返す", () => {
    const response: DiagramCommentsResponse = {
      ok: false,
      code: "INVALID_SIDECAR",
      error: "broken",
    };
    const result = toDiagramCommentPortResult("req-2", response);

    expect(result).toEqual({
      type: "ark:diagram-comments-result",
      requestId: "req-2",
      ok: false,
      code: "INVALID_SIDECAR",
      error: "broken",
    });
    expect(result).not.toHaveProperty("comments");
  });
});
