/**
 * ファイルペイン用の socket ハンドラ (open / list / write / subscribe)。
 * socket のペイロードは信頼できないので、形を確かめてから使う。
 * 同期ハンドラ内の throw はプロセスを落とすため、全体を try/catch で包む。
 */

import path from "node:path";
import type {
  FileListResponse,
  FileOpenResponse,
  FileWriteResponse,
} from "@ark/shared";
import {
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
  /** await 中の購読鍵 (上限と二重購読の判定に数える) */
  const pending = new Set<string>();
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
      const result = p.value.startsWith("/tmp/")
        ? await readFileFromWorktree("", path.resolve(p.value))
        : await readFileFromWorktree(worktreePath, p.value);
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
    let key: string | null = null;
    try {
      const p = parseWith(data, "filePath");
      if (!p || disposed) return;
      const { sessionId, value: filePath } = p;
      const worktreePath = deps.getWorktreePath(sessionId);
      if (worktreePath === undefined) return;
      key = subscriptionKey(sessionId, filePath);
      if (subs.has(key) || pending.has(key)) {
        key = null;
        return;
      }
      if (subs.size + pending.size >= MAX_FILE_SUBSCRIPTIONS) {
        key = null;
        return;
      }
      pending.add(key);
      const absPath = filePath.startsWith("/tmp/")
        ? path.resolve(filePath)
        : await resolveReadablePath(worktreePath, filePath);
      pending.delete(key);
      key = null;
      const off = deps.watcher.subscribe(absPath, () =>
        deps.emitUpdated({ sessionId, filePath })
      );
      // await の間に切断されていたら、張った購読を直ちに解除する
      if (disposed) {
        off();
        return;
      }
      subs.set(subscriptionKey(sessionId, filePath), off);
    } catch {
      // 拒否されたパスや存在しないファイルは購読しない
    } finally {
      if (key !== null) pending.delete(key);
    }
  }

  function unsubscribe(data: unknown): void {
    try {
      const p = parseWith(data, "filePath");
      if (!p) return;
      const key = subscriptionKey(p.sessionId, p.value);
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

  return { open, list, write, subscribe, unsubscribe, dispose };
}
