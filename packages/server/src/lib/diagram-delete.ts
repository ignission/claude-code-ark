import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DiagramDeleteResponse } from "@ark/shared";
import { DIAGRAM_DIR, resolveDiagramPath } from "./diagram-path.js";
import { errnoCode, errnoMessage } from "./errors.js";

const MAX_SESSION_ID_LENGTH = 1024;
const execFileAsync = promisify(execFile);

export type DeleteDiagramFileResult =
  | { ok: true; absPath: string }
  | {
      ok: false;
      code: "NOT_FOUND" | "FORBIDDEN" | "IO_ERROR";
      error: string;
    };

export interface DiagramDeleteRequestDeps {
  getSession: (
    sessionId: string
  ) => { id: string; worktreePath: string } | null | undefined;
  resolveManagedWorktreePath: (worktreePath: string) => string | null;
  isDiagramTracked: (worktreeReal: string, relPath: string) => Promise<boolean>;
  deleteDiagramFile: (
    worktreeReal: string,
    relPath: string
  ) => Promise<DeleteDiagramFileResult>;
  clearSessionLastDiagramIfMatches: (
    sessionId: string,
    relPath: string
  ) => boolean;
  onSessionCleared: (sessionId: string) => void;
  onDeleted: (data: { sessionId: string; relPath: string }) => void;
}

interface DiagramDeleteFs {
  open: (
    filePath: string,
    flags: number
  ) => Promise<import("node:fs/promises").FileHandle>;
  realpath: (filePath: string) => Promise<string>;
  stat: (filePath: string) => Promise<fs.Stats>;
  lstatSync: (filePath: string) => fs.Stats;
  unlinkSync: (filePath: string) => void;
}

interface DeleteDiagramFileOptions {
  fs?: DiagramDeleteFs;
  beforeFinalIdentityCheck?: (absPath: string) => void;
}

const defaultDeleteFs: DiagramDeleteFs = {
  open: fs.promises.open,
  realpath: fs.promises.realpath,
  stat: fs.promises.stat,
  lstatSync: fs.lstatSync,
  unlinkSync: fs.unlinkSync,
};

function forbidden(error: string): DeleteDiagramFileResult {
  return { ok: false, code: "FORBIDDEN", error };
}

function resolveDeleteDiagramPath(
  worktreeReal: string,
  relPath: string
): ReturnType<typeof resolveDiagramPath> {
  const normalized = path.normalize(relPath);
  if (
    path.dirname(normalized) !== "." &&
    !normalized.startsWith(`${DIAGRAM_DIR}${path.sep}`)
  ) {
    return {
      ok: false,
      error: `図ファイルは ${DIAGRAM_DIR} 配下で指定してください`,
    };
  }
  return resolveDiagramPath(worktreeReal, relPath);
}

export async function isDiagramTracked(
  worktreeReal: string,
  relPath: string
): Promise<boolean> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", worktreeReal, "ls-files", "--cached", "-z", "--", relPath],
    { encoding: "utf8" }
  );
  return stdout.split("\0").some(candidate => candidate === relPath);
}

export async function deleteDiagramFile(
  worktreeReal: string,
  relPath: string,
  options: DeleteDiagramFileOptions = {}
): Promise<DeleteDiagramFileResult> {
  const resolved = resolveDeleteDiagramPath(worktreeReal, relPath);
  if (!resolved.ok) {
    return forbidden(resolved.error);
  }

  const deleteFs = options.fs ?? defaultDeleteFs;
  const diagramsDir = path.join(worktreeReal, DIAGRAM_DIR);
  let fd: import("node:fs/promises").FileHandle | null = null;
  try {
    fd = await deleteFs.open(
      resolved.absPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    const fdStat = await fd.stat();
    if (!fdStat.isFile()) {
      return forbidden("削除対象は通常ファイルではありません");
    }

    const realPath = await deleteFs.realpath(resolved.absPath);
    const realStat = await deleteFs.stat(realPath);
    if (fdStat.ino !== realStat.ino || fdStat.dev !== realStat.dev) {
      return forbidden("図ファイルの実体を検証できません");
    }
    if (
      realPath !== diagramsDir &&
      !realPath.startsWith(diagramsDir + path.sep)
    ) {
      return forbidden(
        `図ファイルの実体が worktree の ${DIAGRAM_DIR} から出ています`
      );
    }

    options.beforeFinalIdentityCheck?.(resolved.absPath);
    const finalStat = deleteFs.lstatSync(resolved.absPath);
    if (
      !finalStat.isFile() ||
      finalStat.ino !== fdStat.ino ||
      finalStat.dev !== fdStat.dev
    ) {
      return forbidden("削除直前に図ファイルの実体が変化しました");
    }
    deleteFs.unlinkSync(resolved.absPath);
    return { ok: true, absPath: resolved.absPath };
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT") {
      return {
        ok: false,
        code: "NOT_FOUND",
        error: "図ファイルが見つかりません",
      };
    }
    if (
      code === "EACCES" ||
      code === "EPERM" ||
      code === "ELOOP" ||
      code === "EMLINK"
    ) {
      return forbidden(`図ファイルへのアクセスが拒否されました (${code})`);
    }
    return {
      ok: false,
      code: "IO_ERROR",
      error: `図ファイルの削除に失敗しました (${code}): ${errnoMessage(error)}`,
    };
  } finally {
    try {
      await fd?.close();
    } catch {
      // unlink の成否を close error で反転させない。
    }
  }
}

function isValidRequest(
  data: unknown
): data is { sessionId: string; relPath: string; expectedTracked: boolean } {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const request = data as Record<string, unknown>;
  return (
    typeof request.sessionId === "string" &&
    request.sessionId.length > 0 &&
    request.sessionId.length <= MAX_SESSION_ID_LENGTH &&
    typeof request.relPath === "string" &&
    request.relPath.length > 0 &&
    typeof request.expectedTracked === "boolean"
  );
}

export async function handleDiagramDeleteRequest(
  deps: DiagramDeleteRequestDeps,
  data: unknown
): Promise<DiagramDeleteResponse> {
  if (!isValidRequest(data)) {
    return {
      ok: false,
      code: "BAD_REQUEST",
      error: "不正なリクエストです",
    };
  }

  const session = deps.getSession(data.sessionId);
  if (!session) {
    return {
      ok: false,
      code: "SESSION_NOT_FOUND",
      error: "セッションが見つかりません",
    };
  }
  const worktreeReal = deps.resolveManagedWorktreePath(session.worktreePath);
  if (!worktreeReal) {
    return {
      ok: false,
      code: "FORBIDDEN",
      error: "管理対象の worktree ではありません",
    };
  }

  const resolved = resolveDeleteDiagramPath(worktreeReal, data.relPath);
  if (!resolved.ok) {
    return {
      ok: false,
      code: "FORBIDDEN",
      error: resolved.error,
    };
  }

  let tracked: boolean;
  try {
    tracked = await deps.isDiagramTracked(worktreeReal, data.relPath);
  } catch (error) {
    return {
      ok: false,
      code: "IO_ERROR",
      error: `Git 管理状態の確認に失敗しました (${errnoCode(error)}): ${errnoMessage(error)}`,
    };
  }
  if (tracked !== data.expectedTracked) {
    return {
      ok: false,
      code: "CONFLICT",
      error: "Git 管理状態が変化しました。一覧を更新して再確認してください",
    };
  }

  const deleted = await deps.deleteDiagramFile(worktreeReal, data.relPath);
  if (!deleted.ok) return deleted;

  let warning: string | undefined;
  try {
    const cleared = deps.clearSessionLastDiagramIfMatches(
      data.sessionId,
      data.relPath
    );
    if (cleared) deps.onSessionCleared(data.sessionId);
  } catch (error) {
    warning = `ファイルは削除済みですが復元情報の消去に失敗しました: ${errnoMessage(error)}`;
  }
  deps.onDeleted({ sessionId: data.sessionId, relPath: data.relPath });
  return {
    ok: true,
    relPath: data.relPath,
    tracked,
    ...(warning ? { warning } : {}),
  };
}

type DiagramDeleteRequestHandler = (
  deps: DiagramDeleteRequestDeps,
  data: unknown
) => Promise<DiagramDeleteResponse>;

export function createDiagramDeleteSocketHandler(
  deps: DiagramDeleteRequestDeps,
  requestHandler: DiagramDeleteRequestHandler = handleDiagramDeleteRequest
): (data: unknown, callback: unknown) => void {
  return (data: unknown, callback: unknown): void => {
    if (typeof callback !== "function") return;
    const reply = callback as (response: DiagramDeleteResponse) => void;
    const safeReply = (response: DiagramDeleteResponse): void => {
      try {
        reply(response);
      } catch {
        // ACK callback は client 由来。throw を server process へ伝播させない。
      }
    };
    void requestHandler(deps, data).then(safeReply, error => {
      safeReply({
        ok: false,
        code: "IO_ERROR",
        error: `図ファイルの削除に失敗しました: ${errnoMessage(error)}`,
      });
    });
  };
}
