import type { DiagramCommentsFile, DiagramCommentsResponse } from "@ark/shared";

export type DiagramCommentPortRequest =
  | { type: "ark:diagram-comments-load"; requestId: string }
  | {
      type: "ark:diagram-comment-create";
      requestId: string;
      anchorId: string;
      anchorQuote?: string;
      anchorOccurrence?: number;
      author: string;
      body: string;
    }
  | {
      type: "ark:diagram-comment-resolve";
      requestId: string;
      threadId: string;
    };

export type DiagramCommentPortParse =
  | { kind: "request"; request: DiagramCommentPortRequest }
  | { kind: "invalid"; requestId: string; error: string }
  | { kind: "ignore" };

type DiagramCommentsErrorCode = Extract<
  DiagramCommentsResponse,
  { ok: false }
>["code"];

export type DiagramCommentPortResult =
  | {
      type: "ark:diagram-comments-result";
      requestId: string;
      ok: true;
      comments: DiagramCommentsFile;
    }
  | {
      type: "ark:diagram-comments-result";
      requestId: string;
      ok: false;
      code: DiagramCommentsErrorCode;
      error: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every(key => keys.includes(key))
  );
}

function unknownKeys(value: Record<string, unknown>, keys: string[]): string[] {
  return Object.keys(value).filter(key => !keys.includes(key));
}

function summarizeUnknownKeys(keys: string[]): string {
  const maxCount = 3;
  const maxLength = 40;
  const summarized = keys
    .slice(0, maxCount)
    .map(key => (key.length > maxLength ? `${key.slice(0, maxLength)}…` : key));
  if (keys.length > maxCount) {
    summarized.push(`ほか ${keys.length - maxCount} 件`);
  }
  return summarized.join(", ");
}

function validString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !value.includes("\0")
  );
}

/** iframe port の untrusted data を要求・検証失敗・対象外へ分類する。 */
export function parseDiagramCommentPortRequest(
  value: unknown
): DiagramCommentPortParse {
  if (
    !isRecord(value) ||
    (value.type !== "ark:diagram-comments-load" &&
      value.type !== "ark:diagram-comment-create" &&
      value.type !== "ark:diagram-comment-resolve") ||
    !validString(value.requestId, 256)
  ) {
    return { kind: "ignore" };
  }

  const invalid = (error: string): DiagramCommentPortParse => ({
    kind: "invalid",
    requestId: value.requestId as string,
    error,
  });

  if (value.type === "ark:diagram-comments-load") {
    if (!hasOnlyKeys(value, ["type", "requestId"])) {
      return invalid(
        `コメント取得要求の不明なフィールド: ${summarizeUnknownKeys(unknownKeys(value, ["type", "requestId"]))}`
      );
    }
    return {
      kind: "request",
      request: { type: value.type, requestId: value.requestId },
    };
  }

  if (value.type === "ark:diagram-comment-create") {
    const allowedKeys = [
      "type",
      "requestId",
      "anchorId",
      "anchorQuote",
      "anchorOccurrence",
      "author",
      "body",
    ];
    const unexpected = unknownKeys(value, allowedKeys);
    if (unexpected.length > 0) {
      return invalid(
        `コメント作成要求の不明なフィールド: ${summarizeUnknownKeys(unexpected)}`
      );
    }
    if (!validString(value.anchorId, 256)) {
      return invalid("アンカー ID（anchorId）が不正です");
    }
    if (!validString(value.author, 80)) {
      return invalid("名前（author）が不正です");
    }
    if (!validString(value.body, 4000)) {
      return invalid("コメント本文（body）が不正です。本文を入力してください");
    }
    if (
      value.anchorQuote !== undefined &&
      !validString(value.anchorQuote, 1000)
    ) {
      return invalid("選択本文（anchorQuote）が不正です");
    }
    if (
      value.anchorOccurrence !== undefined &&
      (value.anchorQuote === undefined ||
        !Number.isSafeInteger(value.anchorOccurrence) ||
        (value.anchorOccurrence as number) < 0)
    ) {
      return invalid("選択位置（anchorOccurrence）が不正です");
    }
    const request: Extract<
      DiagramCommentPortRequest,
      { type: "ark:diagram-comment-create" }
    > = {
      type: value.type,
      requestId: value.requestId,
      anchorId: value.anchorId,
      author: value.author,
      body: value.body,
    };
    if (value.anchorQuote !== undefined) {
      request.anchorQuote = value.anchorQuote as string;
    }
    if (value.anchorOccurrence !== undefined) {
      request.anchorOccurrence = value.anchorOccurrence as number;
    }
    return { kind: "request", request };
  }

  const unexpected = unknownKeys(value, ["type", "requestId", "threadId"]);
  if (unexpected.length > 0) {
    return invalid(
      `コメント解決要求の不明なフィールド: ${summarizeUnknownKeys(unexpected)}`
    );
  }
  if (!validString(value.threadId, 256)) {
    return invalid("スレッド ID（threadId）が不正です");
  }
  return {
    kind: "request",
    request: {
      type: value.type,
      requestId: value.requestId,
      threadId: value.threadId,
    },
  };
}

export function toDiagramCommentPortResult(
  requestId: string,
  response: DiagramCommentsResponse
): DiagramCommentPortResult {
  if (response.ok) {
    return {
      type: "ark:diagram-comments-result",
      requestId,
      ok: true,
      comments: response.comments,
    };
  }
  return {
    type: "ark:diagram-comments-result",
    requestId,
    ok: false,
    code: response.code,
    error: response.error,
  };
}
