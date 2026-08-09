import fs from "node:fs";
import path from "node:path";
import type {
  DiagramCommentMessage,
  DiagramCommentsFile,
  DiagramCommentsResponse,
  DiagramCommentThread,
} from "@ark/shared";
import { DIAGRAM_DIR, resolveDiagramPath } from "./diagram-path.js";
import { errnoCode, errnoMessage } from "./errors.js";

export const DIAGRAM_COMMENTS_MAX_BYTES = 1024 * 1024;
export const DIAGRAM_COMMENTS_MAX_THREADS = 1000;
export const DIAGRAM_COMMENTS_MAX_AUTHOR_LENGTH = 80;
export const DIAGRAM_COMMENTS_MAX_BODY_LENGTH = 4000;
export const DIAGRAM_COMMENTS_MAX_ANCHOR_OR_ID_LENGTH = 256;

export type DiagramCommentsPathResult =
  | {
      ok: true;
      diagramAbsPath: string;
      commentsAbsPath: string;
      diagramRelPath: string;
      target: string;
    }
  | {
      ok: false;
      code: "BAD_REQUEST" | "FORBIDDEN";
      error: string;
    };

function invalid(error: string): DiagramCommentsResponse {
  return { ok: false, code: "INVALID_SIDECAR", error };
}

function ioError(prefix: string, error: unknown): DiagramCommentsResponse {
  const code = errnoCode(error);
  return {
    ok: false,
    code: "IO_ERROR",
    error: `${prefix} (${code}): ${errnoMessage(error)}`,
  };
}

export function emptyDiagramComments(target: string): DiagramCommentsFile {
  return { version: 1, target, threads: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  name: string,
  maxLength: number
): { ok: true; value: string } | { ok: false; error: string } {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    return {
      ok: false,
      error: `${name} は1〜${maxLength}文字である必要があります`,
    };
  }
  return { ok: true, value };
}

function timestamp(
  value: unknown,
  name: string
): { ok: true; value: string } | { ok: false; error: string } {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return { ok: false, error: `${name} は ISO timestamp が必要です` };
  }
  return { ok: true, value };
}

/** 検証済みの図 path だけから隣接 sidecar path を導出する。 */
export function resolveDiagramCommentsPath(
  worktreeReal: string,
  relPath: string
): DiagramCommentsPathResult {
  if (relPath.includes("\0")) {
    return {
      ok: false,
      code: "BAD_REQUEST",
      error: "図のパスに NUL は使用できません",
    };
  }
  const diagram = resolveDiagramPath(worktreeReal, relPath);
  if (!diagram.ok) {
    const forbidden = path.isAbsolute(relPath) || relPath.includes("..");
    return {
      ok: false,
      code: forbidden ? "FORBIDDEN" : "BAD_REQUEST",
      error: diagram.error,
    };
  }
  const target = path.basename(diagram.absPath);
  return {
    ok: true,
    diagramAbsPath: diagram.absPath,
    commentsAbsPath: diagram.absPath.replace(
      /\.diagram\.html$/u,
      ".comments.json"
    ),
    diagramRelPath: diagram.relPath,
    target,
  };
}

/** sidecar JSON を正規化し、破損を typed error として返す。 */
export function parseDiagramComments(
  raw: string,
  expectedTarget: string
): DiagramCommentsResponse {
  if (Buffer.byteLength(raw, "utf8") > DIAGRAM_COMMENTS_MAX_BYTES) {
    return invalid("コメント sidecar のサイズが大きすぎます（上限 1MiB）");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return invalid(
      `コメント sidecar の JSON を解析できません: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isRecord(value)) return invalid("コメント sidecar は object が必要です");
  if (value.version !== 1) return invalid("version は 1 である必要があります");
  if (value.target !== expectedTarget) {
    return invalid(
      `target が図ファイルと一致しません: ${String(value.target)}`
    );
  }
  if (!Array.isArray(value.threads)) {
    return invalid("threads は配列である必要があります");
  }
  if (value.threads.length > DIAGRAM_COMMENTS_MAX_THREADS) {
    return invalid(`threads は ${DIAGRAM_COMMENTS_MAX_THREADS} 件までです`);
  }

  const seenIds = new Set<string>();
  const threads: DiagramCommentThread[] = [];
  for (const [threadIndex, rawThread] of value.threads.entries()) {
    if (!isRecord(rawThread)) {
      return invalid(`threads[${threadIndex}] は object が必要です`);
    }
    const id = boundedString(
      rawThread.id,
      `threads[${threadIndex}].id`,
      DIAGRAM_COMMENTS_MAX_ANCHOR_OR_ID_LENGTH
    );
    const anchorId = boundedString(
      rawThread.anchorId,
      `threads[${threadIndex}].anchorId`,
      DIAGRAM_COMMENTS_MAX_ANCHOR_OR_ID_LENGTH
    );
    const anchorText = boundedString(
      rawThread.anchorText,
      `threads[${threadIndex}].anchorText`,
      DIAGRAM_COMMENTS_MAX_ANCHOR_OR_ID_LENGTH
    );
    const createdAt = timestamp(
      rawThread.createdAt,
      `threads[${threadIndex}].createdAt`
    );
    if (!id.ok) return invalid(id.error);
    if (!anchorId.ok) return invalid(anchorId.error);
    if (!anchorText.ok) return invalid(anchorText.error);
    if (!createdAt.ok) return invalid(createdAt.error);
    if (seenIds.has(id.value))
      return invalid(`id が重複しています: ${id.value}`);
    seenIds.add(id.value);
    if (rawThread.status !== "open" && rawThread.status !== "resolved") {
      return invalid(`不明な status です: ${String(rawThread.status)}`);
    }
    if (!Array.isArray(rawThread.messages) || rawThread.messages.length === 0) {
      return invalid(`threads[${threadIndex}].messages は1件以上必要です`);
    }

    const messages: DiagramCommentMessage[] = [];
    for (const [messageIndex, rawMessage] of rawThread.messages.entries()) {
      if (!isRecord(rawMessage)) {
        return invalid(
          `threads[${threadIndex}].messages[${messageIndex}] は object が必要です`
        );
      }
      const prefix = `threads[${threadIndex}].messages[${messageIndex}]`;
      const messageId = boundedString(
        rawMessage.id,
        `${prefix}.id`,
        DIAGRAM_COMMENTS_MAX_ANCHOR_OR_ID_LENGTH
      );
      const author = boundedString(
        rawMessage.author,
        `${prefix}.author`,
        DIAGRAM_COMMENTS_MAX_AUTHOR_LENGTH
      );
      const body = boundedString(
        rawMessage.body,
        `${prefix}.body`,
        DIAGRAM_COMMENTS_MAX_BODY_LENGTH
      );
      const at = timestamp(rawMessage.at, `${prefix}.at`);
      if (!messageId.ok) return invalid(messageId.error);
      if (!author.ok) return invalid(author.error);
      if (!body.ok) return invalid(body.error);
      if (!at.ok) return invalid(at.error);
      if (seenIds.has(messageId.value)) {
        return invalid(`id が重複しています: ${messageId.value}`);
      }
      seenIds.add(messageId.value);
      messages.push({
        id: messageId.value,
        author: author.value,
        at: at.value,
        body: body.value,
      });
    }

    threads.push({
      id: id.value,
      anchorId: anchorId.value,
      anchorText: anchorText.value,
      status: rawThread.status,
      createdAt: createdAt.value,
      messages,
    });
  }

  const comments: DiagramCommentsFile = {
    version: 1,
    target: expectedTarget,
    threads,
  };
  return { ok: true, comments };
}

/** ENOENT だけを空として扱い、実体検証済み sidecar を読む。 */
export async function readDiagramCommentsFile(
  worktreeReal: string,
  relPath: string
): Promise<DiagramCommentsResponse> {
  const resolved = resolveDiagramCommentsPath(worktreeReal, relPath);
  if (!resolved.ok) return resolved;

  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(
      resolved.commentsAbsPath,
      fs.constants.O_RDONLY
    );
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return { ok: true, comments: emptyDiagramComments(resolved.target) };
    }
    return ioError("コメント sidecar を開けません", error);
  }

  let result: DiagramCommentsResponse;
  try {
    const descriptorStat = await handle.stat();
    if (!descriptorStat.isFile()) {
      result = {
        ok: false,
        code: "FORBIDDEN",
        error: "コメント sidecar は通常ファイルである必要があります",
      };
    } else {
      const realPath = await fs.promises.realpath(resolved.commentsAbsPath);
      const realStat = await fs.promises.stat(realPath);
      const diagramsDir = path.join(worktreeReal, DIAGRAM_DIR);
      if (
        descriptorStat.ino !== realStat.ino ||
        descriptorStat.dev !== realStat.dev
      ) {
        result = {
          ok: false,
          code: "FORBIDDEN",
          error: "コメント sidecar の実体を検証できません",
        };
      } else if (!realStat.isFile()) {
        result = {
          ok: false,
          code: "FORBIDDEN",
          error: "コメント sidecar は通常ファイルである必要があります",
        };
      } else if (
        realPath !== diagramsDir &&
        !realPath.startsWith(diagramsDir + path.sep)
      ) {
        result = {
          ok: false,
          code: "FORBIDDEN",
          error: `コメント sidecar の実体が worktree の ${DIAGRAM_DIR} から出ています`,
        };
      } else if (descriptorStat.size > DIAGRAM_COMMENTS_MAX_BYTES) {
        result = invalid(
          "コメント sidecar のサイズが大きすぎます（上限 1MiB）"
        );
      } else {
        const raw = await handle.readFile("utf8");
        result = parseDiagramComments(raw, resolved.target);
      }
    }
  } catch (error) {
    result = ioError("コメント sidecar の読み込みに失敗しました", error);
  }

  try {
    await handle.close();
  } catch (error) {
    return ioError("コメント sidecar を close できません", error);
  }
  return result;
}
