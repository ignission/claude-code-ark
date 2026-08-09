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

function validString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !value.includes("\0")
  );
}

/** iframe port の untrusted data を3種類の request だけへ narrow する。 */
export function parseDiagramCommentPortRequest(
  value: unknown
): DiagramCommentPortRequest | null {
  if (!isRecord(value) || !validString(value.requestId, 256)) return null;
  if (
    value.type === "ark:diagram-comments-load" &&
    hasOnlyKeys(value, ["type", "requestId"])
  ) {
    return { type: value.type, requestId: value.requestId };
  }
  if (
    value.type === "ark:diagram-comment-create" &&
    Object.keys(value).every(key =>
      [
        "type",
        "requestId",
        "anchorId",
        "anchorQuote",
        "anchorOccurrence",
        "author",
        "body",
      ].includes(key)
    ) &&
    validString(value.anchorId, 256) &&
    validString(value.author, 80) &&
    validString(value.body, 4000) &&
    (value.anchorQuote === undefined || validString(value.anchorQuote, 1000)) &&
    (value.anchorOccurrence === undefined ||
      (value.anchorQuote !== undefined &&
        Number.isSafeInteger(value.anchorOccurrence) &&
        (value.anchorOccurrence as number) >= 0))
  ) {
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
    return request;
  }
  if (
    value.type === "ark:diagram-comment-resolve" &&
    hasOnlyKeys(value, ["type", "requestId", "threadId"]) &&
    validString(value.threadId, 256)
  ) {
    return {
      type: value.type,
      requestId: value.requestId,
      threadId: value.threadId,
    };
  }
  return null;
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
