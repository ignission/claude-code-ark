/**
 * 付箋と白紙のボードの、Socket.IO の受け口から切り出した core。外部入力をここで確かめる。
 * 付箋そのものの決まりは diagram-notes.ts にある。
 */

import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  DiagramCreateResponse,
  DiagramNoteOp,
  DiagramNotesResponse,
} from "@ark/shared";
import { parseNoteOp } from "./diagram-notes.js";
import { DIAGRAM_DIR } from "./diagram-path.js";
import { errnoCode, errnoMessage } from "./errors.js";
import { m } from "./i18n.js";

const MAX_PATH_LENGTH = 4096;
const MAX_TITLE_LENGTH = 80;

export interface DiagramNotesHandlerDeps {
  resolveManagedWorktreePath: (worktreePath: string) => string | null;
  readNotes: (
    worktreeReal: string,
    relPath: string
  ) => Promise<DiagramNotesResponse>;
  applyOp: (
    worktreeReal: string,
    relPath: string,
    op: DiagramNoteOp,
    viewWidth?: number
  ) => Promise<DiagramNotesResponse>;
}

function readTarget(
  deps: Pick<DiagramNotesHandlerDeps, "resolveManagedWorktreePath">,
  data: unknown
): { worktreeReal: string; relPath: string } | null {
  const request = data as { worktreePath?: unknown; relPath?: unknown } | null;
  if (
    !request ||
    typeof request !== "object" ||
    typeof request.worktreePath !== "string" ||
    typeof request.relPath !== "string" ||
    request.worktreePath.length === 0 ||
    request.worktreePath.length > MAX_PATH_LENGTH ||
    request.relPath.length > MAX_PATH_LENGTH
  ) {
    return null;
  }
  const worktreeReal = deps.resolveManagedWorktreePath(request.worktreePath);
  if (!worktreeReal) return null;
  return { worktreeReal, relPath: request.relPath };
}

export async function handleDiagramNotesGet(
  deps: DiagramNotesHandlerDeps,
  data: unknown
): Promise<DiagramNotesResponse> {
  const target = readTarget(deps, data);
  if (!target) return { ok: false, code: "forbidden" };
  try {
    return await deps.readNotes(target.worktreeReal, target.relPath);
  } catch {
    return { ok: false, code: "io" };
  }
}

export async function handleDiagramNoteOp(
  deps: DiagramNotesHandlerDeps,
  data: unknown
): Promise<DiagramNotesResponse> {
  const target = readTarget(deps, data);
  if (!target) return { ok: false, code: "forbidden" };
  const request = data as { op?: unknown; viewWidth?: unknown };
  const op = parseNoteOp(request.op);
  if (!op) return { ok: false, code: "forbidden" };
  const viewWidth =
    typeof request.viewWidth === "number" ? request.viewWidth : undefined;
  try {
    return await deps.applyOp(
      target.worktreeReal,
      target.relPath,
      op,
      viewWidth
    );
  } catch {
    return { ok: false, code: "io" };
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 白紙のボードの本文。付箋を置く地の紙だけを持つ普通の図で、Claude があとから
 * 図を描き足してもよい。
 */
export function blankBoardHtml(title: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; }
  body { min-height: 100vh; background: #fbfaf7; background-image: radial-gradient(#d8d5cc 1px, transparent 1px); background-size: 20px 20px; }
</style>
</head>
<body>
</body>
</html>
`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 白紙のボードのファイル名。作った日時から付け、同じ秒に重なったら連番を足す */
export function blankBoardFileName(now: Date, attempt: number): string {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `board-${stamp}${attempt === 0 ? "" : `-${attempt + 1}`}.diagram.html`;
}

/**
 * 白紙のボードを作る。人が付箋から書き始めるための入口で、Claude に頼まなくても
 * ボードを1枚用意できる。
 */
export async function handleDiagramCreate(
  deps: Pick<DiagramNotesHandlerDeps, "resolveManagedWorktreePath">,
  data: unknown,
  now: () => Date = () => new Date()
): Promise<DiagramCreateResponse> {
  const request = data as { worktreePath?: unknown; title?: unknown } | null;
  if (
    !request ||
    typeof request !== "object" ||
    typeof request.worktreePath !== "string" ||
    request.worktreePath.length === 0 ||
    request.worktreePath.length > MAX_PATH_LENGTH ||
    typeof request.title !== "string"
  ) {
    return { ok: false, error: m().serverFiles.invalidRequest };
  }
  const title =
    request.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH) ||
    "Board";
  const worktreeReal = deps.resolveManagedWorktreePath(request.worktreePath);
  if (!worktreeReal) {
    return { ok: false, error: m().serverFiles.unmanagedWorktree };
  }
  const dir = path.join(worktreeReal, DIAGRAM_DIR);
  try {
    await mkdir(dir, { recursive: true });
    // 途中のディレクトリがシンボリックリンクで、worktree の外に作ることにならないか
    if ((await realpath(dir)) !== dir) {
      return {
        ok: false,
        error: m().serverFiles.board.realPathOutsideDir(DIAGRAM_DIR),
      };
    }
    const at = now();
    for (let attempt = 0; attempt < 20; attempt++) {
      const fileName = blankBoardFileName(at, attempt);
      try {
        await writeFile(path.join(dir, fileName), blankBoardHtml(title), {
          flag: "wx",
          mode: 0o644,
        });
        return { ok: true, relPath: path.join(DIAGRAM_DIR, fileName) };
      } catch (error) {
        if (errnoCode(error) !== "EEXIST") throw error;
      }
    }
    return {
      ok: false,
      error: m().serverFiles.board.createFailed("EEXIST", ""),
    };
  } catch (error) {
    return {
      ok: false,
      error: m().serverFiles.board.createFailed(
        errnoCode(error),
        errnoMessage(error)
      ),
    };
  }
}
