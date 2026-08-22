import type { DiagramCommentsResponse } from "@ark/shared";
import {
  type DiagramCommentOperationLog,
  diagramCommentOperationKey,
  diagramCommentOperationLog,
} from "./diagram-comment-operation-log.js";
import {
  appendDiagramCommentMessage,
  createDiagramComment,
  type DiagramCommentMutationOptions,
  deleteDiagramComment,
  readDiagramCommentsFile,
  resolveDiagramComment,
} from "./diagram-comments.js";
import { validateDiagramDocAnchors } from "./diagram-doc-anchors.js";
import { readDiagramModel } from "./diagram-reader.js";
import { errnoMessage } from "./errors.js";

const MAX_SESSION_OR_PATH_LENGTH = 1024;
const MAX_ANCHOR_OR_ID_LENGTH = 256;
const MAX_BODY_LENGTH = 4000;
const MAX_ANCHOR_QUOTE_LENGTH = 1000;

type GetPayload = { sessionId: string; relPath: string };
/**
 * mutation は操作 ID を必須とする。クライアントの ACK タイムアウトは
 * サーバー処理を取り消さないため、再試行を同じ ID で受けて冪等に扱う。
 */
type MutationPayload = GetPayload & { operationId: string };
type CreatePayload = MutationPayload & {
  anchorId: string;
  anchorQuote?: string;
  anchorOccurrence?: number;
  body: string;
};
type ResolvePayload = MutationPayload & { threadId: string };
type ReplyPayload = ResolvePayload & { body: string };

export interface DiagramCommentsHandlerDeps {
  getSession: (
    sessionId: string
  ) => { id: string; worktreePath: string } | null | undefined;
  resolveManagedWorktreePath: (worktreePath: string) => string | null;
  getComments: (
    worktreeReal: string,
    relPath: string
  ) => Promise<DiagramCommentsResponse>;
  createComment: (
    worktreeReal: string,
    relPath: string,
    anchorId: string,
    body: string,
    anchorQuote?: string,
    anchorOccurrence?: number,
    options?: DiagramCommentMutationOptions
  ) => Promise<DiagramCommentsResponse>;
  replyComment: (
    worktreeReal: string,
    relPath: string,
    threadId: string,
    input: { body: string; author?: string },
    options?: DiagramCommentMutationOptions
  ) => Promise<DiagramCommentsResponse>;
  resolveComment: (
    worktreeReal: string,
    relPath: string,
    threadId: string,
    options?: DiagramCommentMutationOptions
  ) => Promise<DiagramCommentsResponse>;
  deleteComment: (
    worktreeReal: string,
    relPath: string,
    threadId: string,
    options?: DiagramCommentMutationOptions
  ) => Promise<DiagramCommentsResponse>;
  sendMessage: (sessionId: string, message: string) => void;
  /**
   * send の二重送信防止に使う適用済み操作の記録。省略時はプロセス共有の
   * 記録を使う（sidecar mutation 側も同じ記録を共有する）。
   */
  operationLog?: DiagramCommentOperationLog;
}

/** get でも mutation と同じ diagram/anchor trust boundary を通す。 */
export async function getDiagramCommentsForDoc(
  worktreeReal: string,
  relPath: string
): Promise<DiagramCommentsResponse> {
  const diagram = await readDiagramModel(worktreeReal, relPath);
  if (!diagram.ok) {
    return {
      ok: false,
      code: diagram.status === 403 ? "FORBIDDEN" : "IO_ERROR",
      error: diagram.error,
    };
  }
  if (diagram.model.type === "doc") {
    const anchors = validateDiagramDocAnchors(diagram.raw, diagram.model);
    if (!anchors.ok) {
      return { ok: false, code: "ANCHOR_NOT_FOUND", error: anchors.error };
    }
  }
  return readDiagramCommentsFile(worktreeReal, relPath);
}

export const diagramCommentsStore = {
  getComments: getDiagramCommentsForDoc,
  createComment: createDiagramComment,
  replyComment: appendDiagramCommentMessage,
  deleteComment: deleteDiagramComment,
  resolveComment: resolveDiagramComment,
};

type RequestContext =
  | { valid: true; worktreeReal: string; sessionId: string; relPath: string }
  | { valid: false; response: DiagramCommentsResponse };

function badRequest(error = "不正なリクエストです"): DiagramCommentsResponse {
  return { ok: false, code: "BAD_REQUEST", error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[]
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === allowed.length && keys.every(key => allowed.includes(key))
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

function parseGetPayload(value: unknown): GetPayload | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["sessionId", "relPath"]) ||
    !validString(value.sessionId, MAX_SESSION_OR_PATH_LENGTH) ||
    !validString(value.relPath, MAX_SESSION_OR_PATH_LENGTH)
  ) {
    return null;
  }
  return { sessionId: value.sessionId, relPath: value.relPath };
}

function parseCreatePayload(value: unknown): CreatePayload | null {
  if (
    !isRecord(value) ||
    !Object.keys(value).every(key =>
      [
        "sessionId",
        "relPath",
        "operationId",
        "anchorId",
        "anchorQuote",
        "anchorOccurrence",
        "body",
      ].includes(key)
    ) ||
    !validString(value.sessionId, MAX_SESSION_OR_PATH_LENGTH) ||
    !validString(value.relPath, MAX_SESSION_OR_PATH_LENGTH) ||
    !validString(value.operationId, MAX_ANCHOR_OR_ID_LENGTH) ||
    !validString(value.anchorId, MAX_ANCHOR_OR_ID_LENGTH) ||
    typeof value.body !== "string"
  ) {
    return null;
  }
  if (
    (value.anchorQuote !== undefined &&
      !validString(value.anchorQuote, MAX_ANCHOR_QUOTE_LENGTH)) ||
    (value.anchorOccurrence !== undefined &&
      (value.anchorQuote === undefined ||
        !Number.isSafeInteger(value.anchorOccurrence) ||
        (value.anchorOccurrence as number) < 0))
  ) {
    return null;
  }
  const body = value.body.trim();
  if (!validString(body, MAX_BODY_LENGTH)) {
    return null;
  }
  const payload: CreatePayload = {
    sessionId: value.sessionId,
    relPath: value.relPath,
    operationId: value.operationId,
    anchorId: value.anchorId,
    body,
  };
  if (value.anchorQuote !== undefined) {
    payload.anchorQuote = value.anchorQuote as string;
  }
  if (value.anchorOccurrence !== undefined) {
    payload.anchorOccurrence = value.anchorOccurrence as number;
  }
  return payload;
}

function parseResolvePayload(value: unknown): ResolvePayload | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["sessionId", "relPath", "operationId", "threadId"]) ||
    !validString(value.sessionId, MAX_SESSION_OR_PATH_LENGTH) ||
    !validString(value.relPath, MAX_SESSION_OR_PATH_LENGTH) ||
    !validString(value.operationId, MAX_ANCHOR_OR_ID_LENGTH) ||
    !validString(value.threadId, MAX_ANCHOR_OR_ID_LENGTH)
  ) {
    return null;
  }
  return {
    sessionId: value.sessionId,
    relPath: value.relPath,
    operationId: value.operationId,
    threadId: value.threadId,
  };
}

function parseReplyPayload(value: unknown): ReplyPayload | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "sessionId",
      "relPath",
      "operationId",
      "threadId",
      "body",
    ]) ||
    !validString(value.sessionId, MAX_SESSION_OR_PATH_LENGTH) ||
    !validString(value.relPath, MAX_SESSION_OR_PATH_LENGTH) ||
    !validString(value.operationId, MAX_ANCHOR_OR_ID_LENGTH) ||
    !validString(value.threadId, MAX_ANCHOR_OR_ID_LENGTH) ||
    typeof value.body !== "string"
  ) {
    return null;
  }
  const body = value.body.trim();
  if (!validString(body, MAX_BODY_LENGTH)) return null;
  return {
    sessionId: value.sessionId,
    relPath: value.relPath,
    operationId: value.operationId,
    threadId: value.threadId,
    body,
  };
}

function oneLine(value: string): string {
  // sidecar は入力をそのまま保持し、tmux へリテラル送出する文面だけを無害化する。
  return value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncate(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("");
}

function buildDiagramCommentMessage(
  relPath: string,
  thread: Extract<
    DiagramCommentsResponse,
    { ok: true }
  >["comments"]["threads"][number],
  otherOpenCount: number
): string | null {
  const latestMessage = thread.messages.at(-1);
  if (!latestMessage) return null;
  // 人間のメッセージが無い旧形式・外部生成 sidecar も送れるよう、最後のメッセージへフォールバックする。
  const message =
    thread.messages.findLast(candidate => candidate.author === undefined) ??
    latestMessage;
  const anchorText = truncate(oneLine(thread.anchorText), 80);
  const quote = oneLine(thread.anchorQuote ?? thread.anchorText);
  const replyCount = thread.messages.filter(
    candidate => candidate.author !== undefined
  ).length;
  const replySuffix = replyCount > 0 ? ` / 返信済み ${replyCount} 件` : "";
  const otherOpenSuffix =
    otherOpenCount > 0
      ? ` / 他に未解決 ${otherOpenCount} 件（board_comments で全件取得できる）`
      : "";
  return `図のコメント（${oneLine(relPath)}） 対象: ${anchorText} / 引用: 「${quote}」 / コメント: ${oneLine(message.body)}${replySuffix}${otherOpenSuffix}`;
}

function requestContext(
  deps: DiagramCommentsHandlerDeps,
  payload: GetPayload
): RequestContext {
  const session = deps.getSession(payload.sessionId);
  if (session === null || session === undefined) {
    return {
      valid: false,
      response: {
        ok: false,
        code: "SESSION_NOT_FOUND",
        error: "セッションが見つかりません",
      },
    };
  }
  const worktreeReal = deps.resolveManagedWorktreePath(session.worktreePath);
  if (worktreeReal === null) {
    return {
      valid: false,
      response: {
        ok: false,
        code: "FORBIDDEN",
        error: "管理対象の worktree ではありません",
      },
    };
  }
  return {
    valid: true,
    worktreeReal,
    sessionId: payload.sessionId,
    relPath: payload.relPath,
  };
}

async function containStoreError(
  operation: () => Promise<DiagramCommentsResponse>
): Promise<DiagramCommentsResponse> {
  try {
    return await operation();
  } catch (error) {
    return {
      ok: false,
      code: "IO_ERROR",
      error: `コメント処理に失敗しました: ${errnoMessage(error)}`,
    };
  }
}

export async function handleDiagramCommentsGet(
  deps: DiagramCommentsHandlerDeps,
  data: unknown
): Promise<DiagramCommentsResponse> {
  const payload = parseGetPayload(data);
  if (payload === null) return badRequest();
  const context = requestContext(deps, payload);
  if (!context.valid) return context.response;
  return containStoreError(() =>
    deps.getComments(context.worktreeReal, context.relPath)
  );
}

export async function handleDiagramCommentCreate(
  deps: DiagramCommentsHandlerDeps,
  data: unknown
): Promise<DiagramCommentsResponse> {
  const payload = parseCreatePayload(data);
  if (payload === null) return badRequest();
  const context = requestContext(deps, payload);
  if (!context.valid) return context.response;
  return containStoreError(() =>
    deps.createComment(
      context.worktreeReal,
      context.relPath,
      payload.anchorId,
      payload.body,
      payload.anchorQuote,
      payload.anchorOccurrence,
      { operationId: payload.operationId }
    )
  );
}

export async function handleDiagramCommentResolve(
  deps: DiagramCommentsHandlerDeps,
  data: unknown
): Promise<DiagramCommentsResponse> {
  const payload = parseResolvePayload(data);
  if (payload === null) return badRequest();
  const context = requestContext(deps, payload);
  if (!context.valid) return context.response;
  return containStoreError(() =>
    deps.resolveComment(
      context.worktreeReal,
      context.relPath,
      payload.threadId,
      { operationId: payload.operationId }
    )
  );
}

export async function handleDiagramCommentReply(
  deps: DiagramCommentsHandlerDeps,
  data: unknown
): Promise<DiagramCommentsResponse> {
  const payload = parseReplyPayload(data);
  if (payload === null) return badRequest();
  const context = requestContext(deps, payload);
  if (!context.valid) return context.response;
  return containStoreError(() =>
    deps.replyComment(
      context.worktreeReal,
      context.relPath,
      payload.threadId,
      { body: payload.body },
      { operationId: payload.operationId }
    )
  );
}

export async function handleDiagramCommentDelete(
  deps: DiagramCommentsHandlerDeps,
  data: unknown
): Promise<DiagramCommentsResponse> {
  const payload = parseResolvePayload(data);
  if (payload === null) return badRequest();
  const context = requestContext(deps, payload);
  if (!context.valid) return context.response;
  return containStoreError(() =>
    deps.deleteComment(
      context.worktreeReal,
      context.relPath,
      payload.threadId,
      { operationId: payload.operationId }
    )
  );
}

export async function handleDiagramCommentSend(
  deps: DiagramCommentsHandlerDeps,
  data: unknown
): Promise<DiagramCommentsResponse> {
  const payload = parseResolvePayload(data);
  if (payload === null) return badRequest();
  const context = requestContext(deps, payload);
  if (!context.valid) return context.response;
  // send は sidecar を変えないが tmux への送信という副作用を持つ。ACK
  // タイムアウト後の再試行で同じコメントを二重に送らないよう、適用済みの
  // 操作 ID なら現在のコメントだけを返す。
  const operationLog = deps.operationLog ?? diagramCommentOperationLog;
  const operationKey = diagramCommentOperationKey(
    "send",
    JSON.stringify([context.worktreeReal, context.relPath]),
    payload.operationId
  );
  return containStoreError(async () => {
    const response = await deps.getComments(
      context.worktreeReal,
      context.relPath
    );
    if (!response.ok) return response;
    if (operationLog.has(operationKey)) return response;
    const thread = response.comments.threads.find(
      candidate => candidate.id === payload.threadId
    );
    if (!thread) {
      return {
        ok: false,
        code: "THREAD_NOT_FOUND",
        error: "コメントスレッドが見つかりません",
      };
    }
    const otherOpenCount = response.comments.threads.filter(
      candidate => candidate.id !== thread.id && candidate.status === "open"
    ).length;
    const message = buildDiagramCommentMessage(
      context.relPath,
      thread,
      otherOpenCount
    );
    if (message === null) {
      return {
        ok: false,
        code: "INVALID_SIDECAR",
        error: "送信できるコメントメッセージがありません",
      };
    }
    deps.sendMessage(context.sessionId, message);
    operationLog.record(operationKey);
    return response;
  });
}

type SocketHandler = (data: unknown, callback: unknown) => void;

function createSocketHandler(
  core: (data: unknown) => Promise<DiagramCommentsResponse>
): SocketHandler {
  return (data, callback): void => {
    if (typeof callback !== "function") return;
    const reply = callback as (response: DiagramCommentsResponse) => void;
    const safeReply = (response: DiagramCommentsResponse): void => {
      try {
        reply(response);
      } catch {
        // ACK callback は client 由来なので、例外を server process へ伝播させない。
      }
    };
    void core(data).then(safeReply, error => {
      safeReply({
        ok: false,
        code: "IO_ERROR",
        error: `コメント処理に失敗しました: ${errnoMessage(error)}`,
      });
    });
  };
}

export function createDiagramCommentsSocketHandlers(
  deps: DiagramCommentsHandlerDeps
): {
  get: SocketHandler;
  create: SocketHandler;
  reply: SocketHandler;
  resolve: SocketHandler;
  delete: SocketHandler;
  send: SocketHandler;
} {
  return {
    get: createSocketHandler(data => handleDiagramCommentsGet(deps, data)),
    create: createSocketHandler(data => handleDiagramCommentCreate(deps, data)),
    reply: createSocketHandler(data => handleDiagramCommentReply(deps, data)),
    resolve: createSocketHandler(data =>
      handleDiagramCommentResolve(deps, data)
    ),
    delete: createSocketHandler(data => handleDiagramCommentDelete(deps, data)),
    send: createSocketHandler(data => handleDiagramCommentSend(deps, data)),
  };
}
