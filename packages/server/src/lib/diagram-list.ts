import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DiagramListItem, DiagramListResponse } from "@ark/shared";
import { DIAGRAM_DIR } from "./diagram-path.js";
import { readDiagramModel } from "./diagram-reader.js";
import { errnoCode, errnoMessage } from "./errors.js";

const DIAGRAM_SUFFIX = ".diagram.html";
const MAX_WORKTREE_PATH_LENGTH = 4096;
const DIAGRAM_READ_CONCURRENCY = 8;
const execFileAsync = promisify(execFile);

async function listTrackedDiagramPaths(
  worktreeReal: string
): Promise<Set<string>> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", worktreeReal, "ls-files", "--cached", "-z", "--", DIAGRAM_DIR],
    { encoding: "utf8" }
  );
  return new Set(stdout.split("\0").filter(Boolean));
}

async function collectDiagramCandidates(
  directory: string,
  relativeParts: string[]
): Promise<string[]> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const candidates: string[] = [];

  for (const entry of entries) {
    const childParts = [...relativeParts, entry.name];
    if (entry.isDirectory()) {
      candidates.push(
        ...(await collectDiagramCandidates(
          path.join(directory, entry.name),
          childParts
        ))
      );
      continue;
    }
    if (entry.name.endsWith(DIAGRAM_SUFFIX)) {
      candidates.push([DIAGRAM_DIR, ...childParts].join("/"));
    }
  }

  return candidates;
}

async function readDiagramListItem(
  worktreeReal: string,
  relPath: string,
  trackedPaths: ReadonlySet<string>
): Promise<DiagramListItem | null> {
  const result = await readDiagramModel(worktreeReal, relPath);
  if (!result.ok) return null;
  const title = result.model.title?.trim();
  return {
    relPath,
    displayName: title || path.posix.basename(relPath),
    tracked: trackedPaths.has(relPath),
  };
}

/**
 * realpath 済みの managed worktree から、有効な図だけを決定的な順序で列挙する。
 * 個々の候補は readDiagramModel() の trust boundary を通過した場合だけ公開する。
 */
export async function listDiagrams(
  worktreeReal: string
): Promise<DiagramListItem[]> {
  const trackedPaths = await listTrackedDiagramPaths(worktreeReal);
  const diagramsDir = path.join(worktreeReal, DIAGRAM_DIR);
  let candidates: string[];
  try {
    candidates = await collectDiagramCandidates(diagramsDir, []);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }

  candidates.sort((a, b) => a.localeCompare(b));
  const items: Array<DiagramListItem | null> = [];
  for (
    let offset = 0;
    offset < candidates.length;
    offset += DIAGRAM_READ_CONCURRENCY
  ) {
    const batch = candidates.slice(offset, offset + DIAGRAM_READ_CONCURRENCY);
    items.push(
      ...(await Promise.all(
        batch.map(relPath =>
          readDiagramListItem(worktreeReal, relPath, trackedPaths)
        )
      ))
    );
  }
  return items.filter((item): item is DiagramListItem => item !== null);
}

export interface DiagramListRequestDeps {
  resolveManagedWorktreePath: (worktreePath: string) => string | null;
  listDiagrams: (worktreeReal: string) => Promise<DiagramListItem[]>;
}

/** Socket.IO ACK handler から切り出した、外部入力を受ける純粋な core。 */
export async function handleDiagramListRequest(
  deps: DiagramListRequestDeps,
  data: unknown
): Promise<DiagramListResponse> {
  const request = data as { worktreePath?: unknown } | null;
  if (
    !request ||
    typeof request !== "object" ||
    typeof request.worktreePath !== "string" ||
    request.worktreePath.length === 0
  ) {
    return { ok: false, error: "不正なリクエストです" };
  }
  if (request.worktreePath.length > MAX_WORKTREE_PATH_LENGTH) {
    return { ok: false, error: "worktree のパスが長すぎます" };
  }

  try {
    const worktreeReal = deps.resolveManagedWorktreePath(request.worktreePath);
    if (!worktreeReal) {
      return { ok: false, error: "管理対象の worktree ではありません" };
    }
    const diagrams = await deps.listDiagrams(worktreeReal);
    return { ok: true, diagrams };
  } catch (error) {
    return {
      ok: false,
      error: `図一覧の取得に失敗しました (${errnoCode(error)}): ${errnoMessage(error)}`,
    };
  }
}
