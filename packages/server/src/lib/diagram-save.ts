/**
 * DiagramPane から受け取った編集結果を検証して保存する共通処理。
 * autosave と明示 submit の保存境界を同一に保つ。
 */

import fs from "node:fs";
import { validateDiagramDocAnchors } from "./diagram-doc-anchors.js";
import { validateDiagramDocAuthorship } from "./diagram-doc-authorship.js";
import { ensureDoctype, replaceModelBlock } from "./diagram-file.js";
import { type DiagramModel, parseDiagramModel } from "./diagram-model.js";
import { resolveDiagramPath } from "./diagram-path.js";
import { readDiagramModel } from "./diagram-reader.js";

export const DIAGRAM_SAVE_MAX_HTML_BYTES = 2 * 1024 * 1024;

export type SaveDiagramEditResult =
  | {
      ok: true;
      absPath: string;
      previousModel: DiagramModel;
      savedModel: DiagramModel;
    }
  | { ok: false; error: string };

export async function saveDiagramEdit(
  worktreeReal: string,
  relPath: string,
  model: unknown,
  html: string,
  beforeWrite?: (absPath: string) => void
): Promise<SaveDiagramEditResult> {
  // 保存前の read は既存ファイルの検証と、明示 submit の fallback baseline の
  // 取得を兼ねる。配信用の CSP / ハーネス注入は行わない。
  const current = await readDiagramModel(worktreeReal, relPath);
  if (!current.ok) return { ok: false, error: current.error };

  const modelJson = JSON.stringify(model);
  if (modelJson === undefined) {
    return { ok: false, error: "モデルが指定されていません" };
  }
  const parsed = parseDiagramModel(modelJson);
  if (!parsed.ok) return parsed;

  if (Buffer.byteLength(html, "utf-8") > DIAGRAM_SAVE_MAX_HTML_BYTES) {
    return { ok: false, error: "図のサイズが大きすぎます（上限 2MB）" };
  }

  // クライアント HTML 内のモデルブロックは編集前のままなので、検証済みの
  // 最新モデルへ差し替える。DOM 投影には触れない。
  const replaced = replaceModelBlock(html, parsed.model);
  if (!replaced.ok) return replaced;
  const anchors = validateDiagramDocAnchors(replaced.html, parsed.model);
  if (!anchors.ok) return anchors;
  const authorship = validateDiagramDocAuthorship(replaced.html, parsed.model);
  if (!authorship.ok) return authorship;

  const pathResolved = resolveDiagramPath(worktreeReal, relPath);
  if (!pathResolved.ok) return pathResolved;

  // read と write の間に最終要素を外向き symlink へ差し替えられても辿らない。
  beforeWrite?.(pathResolved.absPath);
  let writeHandle: fs.promises.FileHandle;
  try {
    writeHandle = await fs.promises.open(
      pathResolved.absPath,
      fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW
    );
  } catch {
    return { ok: false, error: "図ファイルの実体を検証できません" };
  }
  try {
    const body = Buffer.from(ensureDoctype(replaced.html), "utf-8");
    await writeHandle.write(body, 0, body.byteLength, 0);
    await writeHandle.truncate(body.byteLength);
  } finally {
    await writeHandle.close();
  }

  return {
    ok: true,
    absPath: pathResolved.absPath,
    previousModel: current.model,
    savedModel: parsed.model,
  };
}
