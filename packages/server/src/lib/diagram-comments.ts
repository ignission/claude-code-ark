import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  DiagramCommentMessage,
  DiagramCommentsFile,
  DiagramCommentsResponse,
  DiagramCommentThread,
} from "@ark/shared";
import { validateDiagramDocAnchors } from "./diagram-doc-anchors.js";
import { DIAGRAM_DIR, resolveDiagramPath } from "./diagram-path.js";
import { readDiagramModel } from "./diagram-reader.js";
import { errnoCode, errnoMessage } from "./errors.js";

export const DIAGRAM_COMMENTS_MAX_BYTES = 1024 * 1024;
export const DIAGRAM_COMMENTS_MAX_THREADS = 1000;
export const DIAGRAM_COMMENTS_MAX_AUTHOR_LENGTH = 80;
export const DIAGRAM_COMMENTS_MAX_BODY_LENGTH = 4000;
export const DIAGRAM_COMMENTS_MAX_ANCHOR_OR_ID_LENGTH = 256;
export const DIAGRAM_COMMENTS_MAX_ANCHOR_QUOTE_LENGTH = 1000;

function normalizeDiagramCommentAnchorText(
  label: string,
  anchorId: string
): string {
  const normalizedLabel = label
    .trim()
    .slice(0, DIAGRAM_COMMENTS_MAX_ANCHOR_OR_ID_LENGTH);
  if (normalizedLabel.length > 0) return normalizedLabel;
  return (
    anchorId.trim().slice(0, DIAGRAM_COMMENTS_MAX_ANCHOR_OR_ID_LENGTH) ||
    "コメント対象"
  );
}

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

interface DeleteDiagramCommentOptions {
  platform?: NodeJS.Platform;
}

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
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value
    ) ||
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
  const commentsAbsPath = diagram.absPath.replace(
    /\.diagram\.html$/u,
    ".comments.json"
  );
  // 現状は resolveDiagramPath の suffix 強制により到達不能。上流の変更で
  // 図 HTML 自体を JSON で上書きしないための不変条件として残す。
  if (commentsAbsPath === diagram.absPath) {
    return {
      ok: false,
      code: "BAD_REQUEST",
      error: "コメント sidecar のパスを図ファイルから導出できません",
    };
  }
  const target = path.basename(diagram.absPath);
  return {
    ok: true,
    diagramAbsPath: diagram.absPath,
    commentsAbsPath,
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
    const anchorQuote =
      rawThread.anchorQuote === undefined
        ? null
        : boundedString(
            rawThread.anchorQuote,
            `threads[${threadIndex}].anchorQuote`,
            DIAGRAM_COMMENTS_MAX_ANCHOR_QUOTE_LENGTH
          );
    const createdAt = timestamp(
      rawThread.createdAt,
      `threads[${threadIndex}].createdAt`
    );
    if (!id.ok) return invalid(id.error);
    if (!anchorId.ok) return invalid(anchorId.error);
    if (!anchorText.ok) return invalid(anchorText.error);
    if (anchorQuote !== null && !anchorQuote.ok) {
      return invalid(anchorQuote.error);
    }
    if (
      rawThread.anchorOccurrence !== undefined &&
      (anchorQuote === null ||
        !Number.isSafeInteger(rawThread.anchorOccurrence) ||
        (rawThread.anchorOccurrence as number) < 0)
    ) {
      return invalid(
        `threads[${threadIndex}].anchorOccurrence は anchorQuote と0以上の整数が必要です`
      );
    }
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
      const author =
        rawMessage.author === undefined
          ? null
          : boundedString(
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
      if (author !== null && !author.ok) return invalid(author.error);
      if (!body.ok) return invalid(body.error);
      if (!at.ok) return invalid(at.error);
      if (seenIds.has(messageId.value)) {
        return invalid(`id が重複しています: ${messageId.value}`);
      }
      seenIds.add(messageId.value);
      messages.push({
        id: messageId.value,
        ...(author?.ok ? { author: author.value } : {}),
        at: at.value,
        body: body.value,
      });
    }

    const thread: DiagramCommentThread = {
      id: id.value,
      anchorId: anchorId.value,
      anchorText: anchorText.value,
      status: rawThread.status,
      createdAt: createdAt.value,
      messages,
    };
    if (anchorQuote?.ok) {
      thread.anchorQuote = anchorQuote.value;
      if (rawThread.anchorOccurrence !== undefined) {
        thread.anchorOccurrence = rawThread.anchorOccurrence as number;
      }
    }
    threads.push(thread);
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

const mutationQueues = new Map<string, Promise<void>>();
type DiagramCommentsError = Extract<DiagramCommentsResponse, { ok: false }>;

async function withMutationQueue<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.then(
    () => gate,
    () => gate
  );
  mutationQueues.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (mutationQueues.get(key) === tail) mutationQueues.delete(key);
  }
}

async function readCurrentDoc(
  worktreeReal: string,
  relPath: string
): Promise<
  | Extract<Awaited<ReturnType<typeof readDiagramModel>>, { ok: true }>
  | DiagramCommentsError
> {
  const diagram = await readDiagramModel(worktreeReal, relPath);
  if (!diagram.ok) {
    return {
      ok: false,
      code: diagram.status === 403 ? "FORBIDDEN" : "IO_ERROR",
      error: diagram.error,
    };
  }
  if (diagram.model.type !== "doc") {
    return { ok: false, code: "NOT_DOC", error: "文書型の図ではありません" };
  }
  const anchors = validateDiagramDocAnchors(diagram.raw, diagram.model);
  if (!anchors.ok) {
    return { ok: false, code: "ANCHOR_NOT_FOUND", error: anchors.error };
  }
  return diagram;
}

async function preflightTarget(
  absPath: string
): Promise<{ ok: true } | DiagramCommentsError> {
  try {
    const targetStat = await fs.promises.lstat(absPath);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      return {
        ok: false,
        code: "FORBIDDEN",
        error: "コメント sidecar は通常ファイルである必要があります",
      };
    }
    return { ok: true };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return { ok: true };
    }
    return ioError("コメント sidecar の実体を検証できません", error);
  }
}

function serializeDiagramComments(comments: DiagramCommentsFile): string {
  return `${JSON.stringify(comments, null, 2)}\n`;
}

async function writeDiagramCommentsFile(
  resolved: Extract<DiagramCommentsPathResult, { ok: true }>,
  comments: DiagramCommentsFile
): Promise<DiagramCommentsResponse> {
  const serialized = serializeDiagramComments(comments);
  const validated = parseDiagramComments(serialized, resolved.target);
  if (!validated.ok) return validated;

  const tempPath = path.join(
    path.dirname(resolved.commentsAbsPath),
    `.${path.basename(resolved.commentsAbsPath)}.${randomUUID()}.tmp`
  );
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(
      tempPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        fs.constants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(serialized, "utf8");
    await handle.close();
    handle = null;

    const preflight = await preflightTarget(resolved.commentsAbsPath);
    if (!preflight.ok) return preflight;
    await fs.promises.rename(tempPath, resolved.commentsAbsPath);
    return validated;
  } catch (error) {
    return ioError("コメント sidecar の保存に失敗しました", error);
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // 元の write error を保持し、下の temp cleanup を続ける。
      }
    }
    try {
      await fs.promises.unlink(tempPath);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        // rename 成功後は temp が無い。失敗時も元 sidecar を優先して保持する。
      }
    }
  }
}

/** 最新の doc/sidecar を再検証して単発コメントを追加する。 */
export async function createDiagramComment(
  worktreeReal: string,
  relPath: string,
  anchorId: string,
  body: string,
  anchorQuote?: string,
  anchorOccurrence?: number
): Promise<DiagramCommentsResponse> {
  const resolved = resolveDiagramCommentsPath(worktreeReal, relPath);
  if (!resolved.ok) return resolved;
  return withMutationQueue(resolved.commentsAbsPath, async () => {
    const diagram = await readCurrentDoc(worktreeReal, relPath);
    if (!diagram.ok) return diagram;
    const anchor = diagram.model.nodes.find(node => node.id === anchorId);
    if (anchor === undefined) {
      return {
        ok: false,
        code: "ANCHOR_NOT_FOUND",
        error: `コメント anchor が見つかりません: ${anchorId}`,
      };
    }
    const validBody = boundedString(
      body,
      "body",
      DIAGRAM_COMMENTS_MAX_BODY_LENGTH
    );
    if (!validBody.ok) {
      return { ok: false, code: "BAD_REQUEST", error: validBody.error };
    }
    const validAnchorQuote =
      anchorQuote === undefined
        ? null
        : boundedString(
            anchorQuote,
            "anchorQuote",
            DIAGRAM_COMMENTS_MAX_ANCHOR_QUOTE_LENGTH
          );
    if (validAnchorQuote !== null && !validAnchorQuote.ok) {
      return { ok: false, code: "BAD_REQUEST", error: validAnchorQuote.error };
    }
    if (
      anchorOccurrence !== undefined &&
      (validAnchorQuote === null ||
        !Number.isSafeInteger(anchorOccurrence) ||
        anchorOccurrence < 0)
    ) {
      return {
        ok: false,
        code: "BAD_REQUEST",
        error: "anchorOccurrence は anchorQuote と0以上の整数が必要です",
      };
    }

    // quote の本文 HTML 内での実在性は、DOM を持たない server では検証しない。
    // HTML 部分木の text 抽出を独自実装すると browser と乖離するため、解決と
    // 「アンカー未解決」の可視化は comment layer に委ねる。

    const current = await readDiagramCommentsFile(worktreeReal, relPath);
    if (!current.ok) return current;
    if (current.comments.threads.length >= DIAGRAM_COMMENTS_MAX_THREADS) {
      return {
        ok: false,
        code: "BAD_REQUEST",
        error: `コメント thread は ${DIAGRAM_COMMENTS_MAX_THREADS} 件までです`,
      };
    }
    const at = new Date().toISOString();
    const next: DiagramCommentsFile = {
      ...current.comments,
      threads: [
        ...current.comments.threads,
        {
          id: `th-${randomUUID()}`,
          anchorId,
          anchorText: normalizeDiagramCommentAnchorText(
            validAnchorQuote?.ok ? validAnchorQuote.value : anchor.label,
            anchorId
          ),
          ...(validAnchorQuote?.ok
            ? {
                anchorQuote: validAnchorQuote.value,
                ...(anchorOccurrence === undefined ? {} : { anchorOccurrence }),
              }
            : {}),
          status: "open",
          createdAt: at,
          messages: [
            {
              id: `m-${randomUUID()}`,
              at,
              body,
            },
          ],
        },
      ],
    };
    if (
      Buffer.byteLength(serializeDiagramComments(next), "utf8") >
      DIAGRAM_COMMENTS_MAX_BYTES
    ) {
      return {
        ok: false,
        code: "BAD_REQUEST",
        error: "コメント sidecar は 1MiB までです",
      };
    }
    return writeDiagramCommentsFile(resolved, next);
  });
}

/** 最新の doc/sidecar を再検証して既存 thread へメッセージを追加する。 */
export async function appendDiagramCommentMessage(
  worktreeReal: string,
  relPath: string,
  threadId: string,
  input: { body: string; author?: string }
): Promise<DiagramCommentsResponse> {
  const resolved = resolveDiagramCommentsPath(worktreeReal, relPath);
  if (!resolved.ok) return resolved;
  return withMutationQueue(resolved.commentsAbsPath, async () => {
    const diagram = await readCurrentDoc(worktreeReal, relPath);
    if (!diagram.ok) return diagram;
    const current = await readDiagramCommentsFile(worktreeReal, relPath);
    if (!current.ok) return current;
    const thread = current.comments.threads.find(item => item.id === threadId);
    if (thread === undefined) {
      return {
        ok: false,
        code: "THREAD_NOT_FOUND",
        error: `コメント thread が見つかりません: ${threadId}`,
      };
    }
    if (!diagram.model.nodes.some(node => node.id === thread.anchorId)) {
      return {
        ok: false,
        code: "ANCHOR_NOT_FOUND",
        error: `コメント anchor が見つかりません: ${thread.anchorId}`,
      };
    }
    if (thread.status === "resolved") {
      return {
        ok: false,
        code: "BAD_REQUEST",
        error: "解決済みのコメントスレッドには返信できません",
      };
    }
    const validBody = boundedString(
      input.body,
      "body",
      DIAGRAM_COMMENTS_MAX_BODY_LENGTH
    );
    if (!validBody.ok) {
      return { ok: false, code: "BAD_REQUEST", error: validBody.error };
    }
    const validAuthor =
      input.author === undefined
        ? null
        : boundedString(
            input.author,
            "author",
            DIAGRAM_COMMENTS_MAX_AUTHOR_LENGTH
          );
    if (validAuthor !== null && !validAuthor.ok) {
      return { ok: false, code: "BAD_REQUEST", error: validAuthor.error };
    }

    const message: DiagramCommentMessage = {
      id: `m-${randomUUID()}`,
      at: new Date().toISOString(),
      body: input.body,
      ...(validAuthor?.ok ? { author: validAuthor.value } : {}),
    };
    const next: DiagramCommentsFile = {
      ...current.comments,
      threads: current.comments.threads.map(item =>
        item.id === threadId
          ? { ...item, messages: [...item.messages, message] }
          : item
      ),
    };
    if (
      Buffer.byteLength(serializeDiagramComments(next), "utf8") >
      DIAGRAM_COMMENTS_MAX_BYTES
    ) {
      return {
        ok: false,
        code: "BAD_REQUEST",
        error: "コメント sidecar は 1MiB までです",
      };
    }
    return writeDiagramCommentsFile(resolved, next);
  });
}

/** 最新の doc/sidecar を再検証して thread を解決済みにする。 */
export async function resolveDiagramComment(
  worktreeReal: string,
  relPath: string,
  threadId: string
): Promise<DiagramCommentsResponse> {
  const resolved = resolveDiagramCommentsPath(worktreeReal, relPath);
  if (!resolved.ok) return resolved;
  return withMutationQueue(resolved.commentsAbsPath, async () => {
    const diagram = await readCurrentDoc(worktreeReal, relPath);
    if (!diagram.ok) return diagram;
    const current = await readDiagramCommentsFile(worktreeReal, relPath);
    if (!current.ok) return current;
    const thread = current.comments.threads.find(item => item.id === threadId);
    if (thread === undefined) {
      return {
        ok: false,
        code: "THREAD_NOT_FOUND",
        error: `コメント thread が見つかりません: ${threadId}`,
      };
    }
    if (!diagram.model.nodes.some(node => node.id === thread.anchorId)) {
      return {
        ok: false,
        code: "ANCHOR_NOT_FOUND",
        error: `コメント anchor が見つかりません: ${thread.anchorId}`,
      };
    }
    if (thread.status === "resolved") return current;

    const next: DiagramCommentsFile = {
      ...current.comments,
      threads: current.comments.threads.map(item =>
        item.id === threadId ? { ...item, status: "resolved" } : item
      ),
    };
    return writeDiagramCommentsFile(resolved, next);
  });
}

/** 空にした sidecar の同一性と配置を再検証し、安全に削除する。失敗は残存を許容する。 */
async function removeEmptyDiagramCommentsFile(
  resolved: Extract<DiagramCommentsPathResult, { ok: true }>,
  worktreeReal: string
): Promise<void> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(
      resolved.commentsAbsPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    const descriptorStat = await handle.stat();
    if (!descriptorStat.isFile()) return;

    const realPath = await fs.promises.realpath(resolved.commentsAbsPath);
    const realStat = await fs.promises.stat(realPath);
    const diagramsDir = path.join(worktreeReal, DIAGRAM_DIR);
    if (
      descriptorStat.ino !== realStat.ino ||
      descriptorStat.dev !== realStat.dev ||
      !realStat.isFile() ||
      (realPath !== diagramsDir && !realPath.startsWith(diagramsDir + path.sep))
    ) {
      return;
    }

    const finalStat = await fs.promises.lstat(resolved.commentsAbsPath);
    if (
      !finalStat.isFile() ||
      finalStat.ino !== descriptorStat.ino ||
      finalStat.dev !== descriptorStat.dev
    ) {
      return;
    }
    await fs.promises.unlink(resolved.commentsAbsPath);
  } catch {
    // 空 sidecar の残存は成功扱い。次回 mutation の atomic write で回収可能。
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // unlink の成否を変えない。
      }
    }
  }
}

/** 最新の doc/sidecar を再検証して thread を物理削除する。 */
export async function deleteDiagramComment(
  worktreeReal: string,
  relPath: string,
  threadId: string,
  options: DeleteDiagramCommentOptions = {}
): Promise<DiagramCommentsResponse> {
  const resolved = resolveDiagramCommentsPath(worktreeReal, relPath);
  if (!resolved.ok) return resolved;
  if ((options.platform ?? process.platform) === "win32") {
    return {
      ok: false,
      code: "FORBIDDEN",
      error:
        "この環境では symlink を安全に検証できないためコメントを削除できません",
    };
  }
  return withMutationQueue(resolved.commentsAbsPath, async () => {
    const diagram = await readCurrentDoc(worktreeReal, relPath);
    if (!diagram.ok) return diagram;
    const current = await readDiagramCommentsFile(worktreeReal, relPath);
    if (!current.ok) return current;
    if (!current.comments.threads.some(thread => thread.id === threadId)) {
      return {
        ok: false,
        code: "THREAD_NOT_FOUND",
        error: `コメント thread が見つかりません: ${threadId}`,
      };
    }

    const next: DiagramCommentsFile = {
      ...current.comments,
      threads: current.comments.threads.filter(
        thread => thread.id !== threadId
      ),
    };
    const written = await writeDiagramCommentsFile(resolved, next);
    if (!written.ok || next.threads.length > 0) return written;
    await removeEmptyDiagramCommentsFile(resolved, worktreeReal);
    return written;
  });
}
