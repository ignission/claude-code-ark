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
        author: "Reviewer",
        body: "本文",
      },
      {
        type: "ark:diagram-comment-create",
        requestId: "req-create",
        anchorId: "s1-p1",
        anchorQuote: "選択した本文",
        anchorOccurrence: 1,
        author: "Reviewer",
        body: "本文",
      },
    ],
    [
      {
        type: "ark:diagram-comment-create",
        requestId: "req-create-first",
        anchorId: "s1-p1",
        anchorQuote: "先頭の一致",
        author: "Reviewer",
        body: "本文",
      },
      {
        type: "ark:diagram-comment-create",
        requestId: "req-create-first",
        anchorId: "s1-p1",
        anchorQuote: "先頭の一致",
        author: "Reviewer",
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
  ])("valid request %j を narrow する", (input, expected) => {
    expect(parseDiagramCommentPortRequest(input)).toEqual(expected);
  });

  it.each([
    null,
    [],
    "request",
    {},
    { type: "unknown", requestId: "req" },
    { type: "ark:diagram-comments-load" },
    { type: "ark:diagram-comments-load", requestId: 1 },
    { type: "ark:diagram-comments-load", requestId: "r".repeat(257) },
    {
      type: "ark:diagram-comments-load",
      requestId: "req",
      anchorId: "extra",
    },
    {
      type: "ark:diagram-comment-create",
      requestId: "req",
      anchorId: "",
      author: "Reviewer",
      body: "本文",
    },
    {
      type: "ark:diagram-comment-create",
      requestId: "req",
      anchorId: "a".repeat(257),
      author: "Reviewer",
      body: "本文",
    },
    {
      type: "ark:diagram-comment-create",
      requestId: "req",
      anchorId: "s1",
      author: "a".repeat(81),
      body: "本文",
    },
    {
      type: "ark:diagram-comment-create",
      requestId: "req",
      anchorId: "s1",
      anchorOccurrence: 0,
      author: "Reviewer",
      body: "本文",
    },
    {
      type: "ark:diagram-comment-create",
      requestId: "req",
      anchorId: "s1",
      anchorQuote: "本文",
      anchorOccurrence: -1,
      author: "Reviewer",
      body: "本文",
    },
    {
      type: "ark:diagram-comment-create",
      requestId: "req",
      anchorId: "s1",
      anchorQuote: "本文",
      anchorOccurrence: 0,
      unknown: true,
      author: "Reviewer",
      body: "本文",
    },
    {
      type: "ark:diagram-comment-create",
      requestId: "req",
      anchorId: "s1",
      author: "Reviewer",
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
  ])("invalid request %j を拒否する", input => {
    expect(parseDiagramCommentPortRequest(input)).toBeNull();
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
