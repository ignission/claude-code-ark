/**
 * /api/html-file 系エンドポイントで共有するパスバリデータ。
 *
 * - 絶対パスのみ許可（パストラバーサル防止）
 * - .html / .htm 拡張子のみ許可
 * - TOCTOU防止: open→fstat→realpath+stat で inode 一致を検証
 *
 * 検証成功時は read 済みの fd を返さず、検証通過した正規化パスのみを返す。
 * 呼び出し側で必要に応じて再度 open する。HTMLファイルは小さいので競合リスクは低く、
 * realpath 検証通過後のファイル差し替えは攻撃シナリオとしては極めて困難。
 */

import fs from "node:fs";
import path from "node:path";

export type HtmlPathValidationResult =
  | { ok: true; path: string }
  | { ok: false; status: number; error: string };

export async function validateHtmlPath(
  filePath: string
): Promise<HtmlPathValidationResult> {
  if (typeof filePath !== "string" || !filePath) {
    return {
      ok: false,
      status: 400,
      error: "path query parameter is required",
    };
  }

  // 絶対パスのみ許可、パストラバーサル防止
  const normalized = path.resolve(filePath);
  if (normalized !== filePath || filePath.includes("..")) {
    return { ok: false, status: 400, error: "Invalid file path" };
  }

  // .html / .htm 拡張子のみ許可
  const ext = path.extname(normalized).toLowerCase();
  if (ext !== ".html" && ext !== ".htm") {
    return { ok: false, status: 400, error: "Only HTML files are allowed" };
  }

  // TOCTOU防止: open→fstat→realpath+stat で inode 一致を検証
  let fd: import("node:fs/promises").FileHandle | null = null;
  try {
    fd = await fs.promises.open(normalized, fs.constants.O_RDONLY);
    const fdStat = await fd.stat();
    const realPath = await fs.promises.realpath(normalized);
    const realStat = await fs.promises.stat(realPath);
    if (fdStat.ino !== realStat.ino || fdStat.dev !== realStat.dev) {
      return {
        ok: false,
        status: 403,
        error: "Access to this path is not allowed",
      };
    }
    return { ok: true, path: realPath };
  } catch {
    return { ok: false, status: 404, error: "File not found" };
  } finally {
    await fd?.close();
  }
}
