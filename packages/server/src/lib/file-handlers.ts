/**
 * ファイルペイン用の socket ハンドラ (open / list / index / write / subscribe)。
 * socket のペイロードは信頼できないので、形を確かめてから使う。
 * 同期ハンドラ内の throw はプロセスを落とすため、全体を try/catch で包む。
 */

import path from "node:path";
import type {
  FileIndexResponse,
  FileListResponse,
  FileOpenResponse,
  FileWriteResponse,
} from "@ark/shared";
import {
  listAllFiles,
  listDirectory,
  readFileFromWorktree,
  resolveReadablePath,
  writeFileToWorktree,
} from "./file-manager.js";
import type { FileWatcher } from "./file-watcher.js";

/** 1 socket あたりの購読数の上限 */
export const MAX_FILE_SUBSCRIPTIONS = 50;

export interface FileHandlersDeps {
  getWorktreePath: (sessionId: string) => string | undefined;
  watcher: Pick<FileWatcher, "subscribe">;
  emitUpdated: (data: { sessionId: string; filePath: string }) => void;
}

type Callback<T> = (r: T) => void;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function subscriptionKey(sessionId: string, filePath: string): string {
  return JSON.stringify([sessionId, filePath]);
}

/**
 * /tmp 配下の絶対パスとして正規化する。`..` を含む、または /tmp の外へ出るなら null。
 * (symlink の検証は resolveReadablePath 側で行う)
 */
function normalizeTmpPath(filePath: string): string | null {
  if (!filePath.startsWith("/tmp/")) return null;
  if (filePath.split("/").includes("..")) return null;
  const resolved = path.resolve(filePath);
  return resolved.startsWith("/tmp/") ? resolved : null;
}

/** { sessionId: string, <field>: string } の形か */
function parseWith(data: unknown, field: string) {
  if (!isRecord(data)) return null;
  const sessionId = data.sessionId;
  const value = data[field];
  if (typeof sessionId !== "string" || typeof value !== "string") return null;
  return { sessionId, value, data };
}

export function createFileHandlers(deps: FileHandlersDeps) {
  const subs = new Map<string, () => void>();
  /** await 中の購読 (上限と二重購読の判定に数える)。cancelled は unsubscribe が立てる */
  const pending = new Map<string, { cancelled: boolean }>();
  let disposed = false;

  async function open(data: unknown, cb: unknown): Promise<void> {
    if (typeof cb !== "function") return;
    const reply = cb as Callback<FileOpenResponse>;
    try {
      const p = parseWith(data, "filePath");
      if (!p) return;
      const worktreePath = deps.getWorktreePath(p.sessionId);
      if (worktreePath === undefined) {
        return reply({ ok: false, error: "セッションが見つかりません" });
      }
      // /tmp 配下はセッションの存在だけ確かめて直接読む (file:read と同じ)
      let result: Awaited<ReturnType<typeof readFileFromWorktree>>;
      if (p.value.startsWith("/tmp/")) {
        const tmpPath = normalizeTmpPath(p.value);
        if (tmpPath === null) {
          return reply({
            ok: false,
            error: "ファイルへのアクセスが拒否されました",
          });
        }
        result = await readFileFromWorktree("", tmpPath);
      } else {
        result = await readFileFromWorktree(worktreePath, p.value);
      }
      reply({
        ok: true,
        content: result.content,
        mimeType: result.mimeType,
        size: result.size,
        mtimeMs: result.mtimeMs,
        editable: result.editable,
      });
    } catch (err) {
      reply({ ok: false, error: errorMessage(err) });
    }
  }

  async function list(data: unknown, cb: unknown): Promise<void> {
    if (typeof cb !== "function") return;
    const reply = cb as Callback<FileListResponse>;
    try {
      const p = parseWith(data, "dirPath");
      if (!p) return;
      const worktreePath = deps.getWorktreePath(p.sessionId);
      if (worktreePath === undefined) {
        return reply({ ok: false, error: "セッションが見つかりません" });
      }
      const { entries, truncated } = await listDirectory(worktreePath, p.value);
      reply({ ok: true, entries, truncated });
    } catch (err) {
      reply({ ok: false, error: errorMessage(err) });
    }
  }

  /** worktree 内の全ファイルのパス (名前で探すための一覧) */
  async function index(data: unknown, cb: unknown): Promise<void> {
    if (typeof cb !== "function") return;
    const reply = cb as Callback<FileIndexResponse>;
    try {
      if (!isRecord(data) || typeof data.sessionId !== "string") return;
      const worktreePath = deps.getWorktreePath(data.sessionId);
      if (worktreePath === undefined) {
        return reply({ ok: false, error: "セッションが見つかりません" });
      }
      const { paths, truncated } = await listAllFiles(worktreePath);
      reply({ ok: true, paths, truncated });
    } catch (err) {
      reply({ ok: false, error: errorMessage(err) });
    }
  }

  async function write(data: unknown, cb: unknown): Promise<void> {
    if (typeof cb !== "function") return;
    const reply = cb as Callback<FileWriteResponse>;
    try {
      const p = parseWith(data, "filePath");
      if (
        !p ||
        typeof p.data.content !== "string" ||
        typeof p.data.expectedMtimeMs !== "number" ||
        (p.data.force !== undefined && typeof p.data.force !== "boolean")
      ) {
        return;
      }
      const worktreePath = deps.getWorktreePath(p.sessionId);
      if (worktreePath === undefined) {
        return reply({
          ok: false,
          code: "error",
          error: "セッションが見つかりません",
        });
      }
      reply(
        await writeFileToWorktree(
          worktreePath,
          p.value,
          p.data.content,
          p.data.expectedMtimeMs,
          p.data.force === true
        )
      );
    } catch (err) {
      reply({ ok: false, code: "error", error: errorMessage(err) });
    }
  }

  async function subscribe(data: unknown): Promise<void> {
    const p = parseWith(data, "filePath");
    if (!p || disposed) return;
    const { sessionId, value: filePath } = p;
    const worktreePath = deps.getWorktreePath(sessionId);
    if (worktreePath === undefined) return;
    const key = subscriptionKey(sessionId, filePath);
    if (subs.has(key) || pending.has(key)) return;
    if (subs.size + pending.size >= MAX_FILE_SUBSCRIPTIONS) return;
    const tmpPath = filePath.startsWith("/tmp/")
      ? normalizeTmpPath(filePath)
      : undefined;
    if (tmpPath === null) return;

    const entry = { cancelled: false };
    pending.set(key, entry);
    try {
      // /tmp 配下は realpath で実体が /tmp にあることを確かめる (symlink 対策)
      const absPath =
        tmpPath !== undefined
          ? await resolveReadablePath("", tmpPath)
          : await resolveReadablePath(worktreePath, filePath);
      // await の間に解除・切断されていたら張らない。unsubscribe は pending から
      // 外すので、その後に来た同じ鍵の再購読は別の entry として進んでいる
      if (disposed || entry.cancelled) return;
      subs.set(
        key,
        deps.watcher.subscribe(absPath, () =>
          deps.emitUpdated({ sessionId, filePath })
        )
      );
    } catch {
      // 拒否されたパスや存在しないファイルは購読しない
    } finally {
      if (pending.get(key) === entry) pending.delete(key);
    }
  }

  function unsubscribe(data: unknown): void {
    try {
      const p = parseWith(data, "filePath");
      if (!p) return;
      const key = subscriptionKey(p.sessionId, p.value);
      const entry = pending.get(key);
      if (entry) {
        entry.cancelled = true;
        pending.delete(key);
      }
      subs.get(key)?.();
      subs.delete(key);
    } catch {
      // 解除の失敗は無視する
    }
  }

  function dispose(): void {
    disposed = true;
    for (const un of subs.values()) {
      try {
        un();
      } catch {
        // 1 件の失敗で残りの解除を止めない
      }
    }
    subs.clear();
    pending.clear();
  }

  return { open, list, index, write, subscribe, unsubscribe, dispose };
}
