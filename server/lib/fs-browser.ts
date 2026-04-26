/**
 * フォルダ選択ダイアログ用のディレクトリ列挙ユーティリティ
 *
 * 指定パス配下のサブディレクトリを返却する。シンボリックリンクは実体を辿り、
 * ディレクトリのみを結果に含める。`fs.readdir` がEACCESで失敗した場合は
 * 空のentriesを返却し、UI側で表示できるようにする。
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FsEntry, FsListResult } from "../../shared/types.js";

/**
 * 指定パス配下のサブディレクトリを列挙する。
 * @param targetPath 絶対パス。未指定時はホームディレクトリ
 */
export async function listDirectory(
  targetPath?: string
): Promise<FsListResult> {
  const target = targetPath ?? os.homedir();
  if (!path.isAbsolute(target)) {
    throw new Error("pathは絶対パスのみ指定可能");
  }
  const normalized = path.resolve(target);

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(normalized);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error("ディレクトリが存在しません");
    }
    if (code === "EACCES") {
      throw new Error("権限がありません");
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    throw new Error("ディレクトリではありません");
  }

  const parent = path.dirname(normalized);
  const parentResolved = parent === normalized ? null : parent;

  let rawEntries: import("node:fs").Dirent[];
  try {
    rawEntries = await fs.readdir(normalized, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES") {
      // 権限がない場合は空のentriesで返却（UI側で「中身なし」表示）
      return {
        path: normalized,
        parent: parentResolved,
        entries: [],
      };
    }
    throw err;
  }

  // シンボリックリンクも含めてディレクトリエントリを解決する
  const dirEntries = await Promise.all(
    rawEntries
      .filter(e => e.isDirectory() || e.isSymbolicLink())
      .map(async (e): Promise<FsEntry | null> => {
        const childPath = path.join(normalized, e.name);
        try {
          const s = await fs.stat(childPath);
          if (!s.isDirectory()) return null;
        } catch {
          // リンク切れ等はスキップ
          return null;
        }
        return {
          name: e.name,
          path: childPath,
          isHidden: e.name.startsWith("."),
        };
      })
  );
  const entries = dirEntries
    .filter((e): e is FsEntry => e !== null)
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));

  return {
    path: normalized,
    parent: parentResolved,
    entries,
  };
}
