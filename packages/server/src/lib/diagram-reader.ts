/**
 * 図ファイルを読み、モデルを取り出し、meta CSP を注入して返す。
 *
 * `resolveDiagramPath` は文字列上の封じ込め（`docs/diagrams` 配下かどうか）しか
 * 見ないため、`docs/diagrams/x.diagram.html` が worktree 外を指す
 * シンボリックリンクだった場合は素通りしてしまう。ここでは
 * `html-path-validator.ts` と同じ水準で open→fstat→realpath+stat による
 * TOCTOU 対策を行い、実体（realpath）が `docs/diagrams` 配下に収まっている
 * ことまで検証する。
 */

import fs from "node:fs";
import path from "node:path";
import { extractModel, injectCsp } from "./diagram-file.js";
import type { DiagramModel } from "./diagram-model.js";
import { DIAGRAM_DIR, resolveDiagramPath } from "./diagram-path.js";

export type ReadDiagramResult =
  | { ok: true; absPath: string; html: string; model: DiagramModel }
  | { ok: false; status: number; error: string };

export async function readDiagram(
  worktreeReal: string,
  relPath: string
): Promise<ReadDiagramResult> {
  const resolved = resolveDiagramPath(worktreeReal, relPath);
  if (!resolved.ok) return { ok: false, status: 403, error: resolved.error };

  const diagramsDir = path.join(worktreeReal, DIAGRAM_DIR);

  let fd: import("node:fs/promises").FileHandle | null = null;
  try {
    // open はシンボリックリンクを辿る。これにより実体（リンク先）を開く。
    fd = await fs.promises.open(resolved.absPath, fs.constants.O_RDONLY);
    const fdStat = await fd.stat();
    const realPath = await fs.promises.realpath(resolved.absPath);
    const realStat = await fs.promises.stat(realPath);

    // fd と realpath 先の inode/device が一致するか（差し替え検出）
    if (fdStat.ino !== realStat.ino || fdStat.dev !== realStat.dev) {
      return {
        ok: false,
        status: 403,
        error: "図ファイルの実体を検証できません",
      };
    }

    // 実体（realpath）が worktree の docs/diagrams 配下に収まっているか
    // （シンボリックリンクで worktree 外を指すケースを弾く）
    if (
      realPath !== diagramsDir &&
      !realPath.startsWith(diagramsDir + path.sep)
    ) {
      return {
        ok: false,
        status: 403,
        error: "図ファイルの実体が worktree の docs/diagrams から出ています",
      };
    }

    const raw = await fd.readFile("utf-8");
    const model = extractModel(raw);
    if (!model.ok) return { ok: false, status: 422, error: model.error };

    return {
      ok: true,
      absPath: resolved.absPath,
      html: injectCsp(raw),
      model: model.model,
    };
  } catch {
    return { ok: false, status: 404, error: "図ファイルが見つかりません" };
  } finally {
    await fd?.close();
  }
}
