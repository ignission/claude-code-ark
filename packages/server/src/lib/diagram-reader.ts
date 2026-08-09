/**
 * 図ファイルを読み、モデルを取り出し、meta CSP を注入して返す。
 *
 * `resolveDiagramPath` は文字列上の封じ込め（`DIAGRAM_DIR` 配下かどうか）しか
 * 見ないため、`DIAGRAM_DIR/x.diagram.html` が worktree 外を指す
 * シンボリックリンクだった場合は素通りしてしまう。ここでは
 * `html-path-validator.ts` と同じ水準で open→fstat→realpath+stat による
 * TOCTOU 対策を行い、実体（realpath）が `DIAGRAM_DIR` 配下に収まっている
 * ことまで検証する。
 */

import fs from "node:fs";
import path from "node:path";
import { injectBuiltinProjection } from "./diagram-builtin.js";
import { validateDiagramDocAnchors } from "./diagram-doc-anchors.js";
import { extractModel, injectCsp } from "./diagram-file.js";
import { injectHarness } from "./diagram-harness.js";
import type { DiagramModel } from "./diagram-model.js";
import { DIAGRAM_DIR, resolveDiagramPath } from "./diagram-path.js";
import { errnoCode, errnoMessage } from "./errors.js";

export type ReadDiagramResult =
  | { ok: true; absPath: string; html: string; model: DiagramModel }
  | { ok: false; status: number; error: string };

export type ReadDiagramModelResult =
  | { ok: true; absPath: string; raw: string; model: DiagramModel }
  | { ok: false; status: number; error: string };

type ReadRawResult =
  | { ok: true; absPath: string; raw: string }
  | { ok: false; status: number; error: string };

/**
 * TOCTOU 対策込みでファイルを読み、生テキストを返す共通コア。
 * open→fstat→realpath+stat の inode/device 一致と、実体が DIAGRAM_DIR 配下に
 * 収まっていることを検証する（symlink による worktree 外脱出を弾く）。
 */
async function readRawVerified(
  worktreeReal: string,
  relPath: string
): Promise<ReadRawResult> {
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

    // 実体（realpath）が worktree の DIAGRAM_DIR 配下に収まっているか
    // （シンボリックリンクで worktree 外を指すケースを弾く）
    if (
      realPath !== diagramsDir &&
      !realPath.startsWith(diagramsDir + path.sep)
    ) {
      return {
        ok: false,
        status: 403,
        error: `図ファイルの実体が worktree の ${DIAGRAM_DIR} から出ています`,
      };
    }

    const raw = await fd.readFile("utf-8");
    return { ok: true, absPath: resolved.absPath, raw };
  } catch (e) {
    // ENOENT (未作成) だけを「見つかりません」として区別する。EACCES /
    // EISDIR 等の一過性・環境要因のエラーまで 404 に畳むと、Claude には
    // 「ファイルが無い」との区別がつかず無意味な再生成を誘発する
    // (managed-worktree.ts の失敗要因分離と同じ方針)。
    const code = errnoCode(e);
    if (code === "ENOENT") {
      return { ok: false, status: 404, error: "図ファイルが見つかりません" };
    }
    if (code === "EACCES" || code === "EPERM") {
      return {
        ok: false,
        status: 403,
        error: `図ファイルへのアクセスが拒否されました (${code})`,
      };
    }
    return {
      ok: false,
      status: 500,
      error: `図ファイルの読み込みに失敗しました (${code}): ${errnoMessage(e)}`,
    };
  } finally {
    await fd?.close();
  }
}

/** 配信用に読む。meta CSP と編集ハーネスを注入した HTML を返す。 */
export async function readDiagram(
  worktreeReal: string,
  relPath: string
): Promise<ReadDiagramResult> {
  const read = await readRawVerified(worktreeReal, relPath);
  if (!read.ok) return read;
  const model = extractModel(read.raw);
  if (!model.ok) return { ok: false, status: 422, error: model.error };
  const anchors = validateDiagramDocAnchors(read.raw, model.model);
  if (!anchors.ok) return { ok: false, status: 422, error: anchors.error };
  // 内蔵図種の投影生成 → CSP → ハーネスの順。投影はハーネスが読む DOM 契約を
  // 満たす必要があるため、ハーネス注入より前に置く
  return {
    ok: true,
    absPath: read.absPath,
    html: injectHarness(
      injectCsp(injectBuiltinProjection(read.raw, model.model))
    ),
    model: model.model,
  };
}

/**
 * モデルだけが欲しい経路（diagram:submit の差分基準など）向けの軽量版。
 * HTML への CSP/ハーネス注入を行わない（配信しない読み取りで無駄な文字列
 * 加工を避ける）。生テキストも返すので、呼び出し側が書き戻しに使える。
 */
export async function readDiagramModel(
  worktreeReal: string,
  relPath: string
): Promise<ReadDiagramModelResult> {
  const read = await readRawVerified(worktreeReal, relPath);
  if (!read.ok) return read;
  const model = extractModel(read.raw);
  if (!model.ok) return { ok: false, status: 422, error: model.error };
  return { ok: true, absPath: read.absPath, raw: read.raw, model: model.model };
}
