import fs from "node:fs";
import path from "node:path";
import type { DiagramListItem, DiagramListResponse } from "@ark/shared";
import { DIAGRAM_DIR } from "./diagram-path.js";
import { readDiagramModel } from "./diagram-reader.js";
import { errnoCode, errnoMessage } from "./errors.js";

const DIAGRAM_SUFFIX = ".diagram.html";
const MAX_WORKTREE_PATH_LENGTH = 4096;

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
  relPath: string
): Promise<DiagramListItem | null> {
  const result = await readDiagramModel(worktreeReal, relPath);
  if (!result.ok) return null;
  const title = result.model.title?.trim();
  return {
    relPath,
    displayName: title || path.posix.basename(relPath),
  };
}

/**
 * realpath 済みの managed worktree から、有効な図だけを決定的な順序で列挙する。
 * 個々の候補は readDiagramModel() の trust boundary を通過した場合だけ公開する。
 */
export async function listDiagrams(
  worktreeReal: string
): Promise<DiagramListItem[]> {
  const diagramsDir = path.join(worktreeReal, DIAGRAM_DIR);
  let candidates: string[];
  try {
    candidates = await collectDiagramCandidates(diagramsDir, []);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }

  candidates.sort((a, b) => a.localeCompare(b));
  const items = await Promise.all(
    candidates.map(relPath => readDiagramListItem(worktreeReal, relPath))
  );
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
