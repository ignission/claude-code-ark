/**
 * 図ファイルのパス解決。worktree 配下の `DIAGRAM_DIR` に封じ込める。
 *
 * worktree の実パス自体の検証は managed-worktree.ts が担い、ここは
 * 「その配下から出ないこと」と「図ファイルであること」だけを見る。
 */

import path from "node:path";
import { DIAGRAM_DIR } from "@ark/shared";

export { DIAGRAM_DIR };

const DIAGRAM_SUFFIX = ".diagram.html";

export type DiagramPathResult =
  | { ok: true; absPath: string; relPath: string }
  | { ok: false; error: string };

export type DiagramRelPathResult =
  | { ok: true; relPath: string }
  | { ok: false; error: string };

/**
 * @param relPath `${DIAGRAM_DIR}/x.diagram.html` または `x.diagram.html`
 */
export function normalizeDiagramRelPath(relPath: string): DiagramRelPathResult {
  if (typeof relPath !== "string" || relPath.length === 0) {
    return { ok: false, error: "図のパスが空です" };
  }
  if (relPath.length > 1024) {
    return { ok: false, error: "図のパスが長すぎます" };
  }
  if (path.isAbsolute(relPath)) {
    return { ok: false, error: "図のパスは worktree 相対で指定してください" };
  }
  if (!relPath.endsWith(DIAGRAM_SUFFIX)) {
    return {
      ok: false,
      error: `図のパスは ${DIAGRAM_SUFFIX} で終わる必要があります`,
    };
  }

  // ディレクトリトラバーサル対策：正規化前のパスに ../が含まれていないか確認
  // (normalize()が../../を消すので、事前に検出する必要がある)
  if (relPath.includes("..")) {
    return {
      ok: false,
      error: `図のパスが worktree の ${DIAGRAM_DIR} から出ています`,
    };
  }

  const normalized = path.normalize(relPath);

  // DIAGRAM_DIR で始まっていればそのまま、そうでなければ前に付ける。
  // （relPath は .diagram.html で終わることを確認済みなので、normalized が
  // DIAGRAM_DIR "そのもの" になることはない = ディレクトリ指定の分岐は不要）
  const withDir = normalized.startsWith(`${DIAGRAM_DIR}${path.sep}`)
    ? normalized
    : path.join(DIAGRAM_DIR, normalized);

  return { ok: true, relPath: withDir };
}

/**
 * @param worktreeReal realpath 済みの worktree 絶対パス
 * @param relPath `${DIAGRAM_DIR}/x.diagram.html` または `x.diagram.html`
 */
export function resolveDiagramPath(
  worktreeReal: string,
  relPath: string
): DiagramPathResult {
  const normalized = normalizeDiagramRelPath(relPath);
  if (!normalized.ok) return normalized;

  const base = path.join(worktreeReal, DIAGRAM_DIR);
  const absPath = path.resolve(worktreeReal, normalized.relPath);

  // 二重チェック：パス解決後も DIAGRAM_DIR 配下であることを確認
  if (absPath !== base && !absPath.startsWith(base + path.sep)) {
    return {
      ok: false,
      error: `図のパスが worktree の ${DIAGRAM_DIR} から出ています`,
    };
  }
  return { ok: true, absPath, relPath: normalized.relPath };
}
