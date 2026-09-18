/**
 * 会話 (JSONL transcript) の最終更新時刻を読む。
 *
 * 一覧をセクションの中で「最終更新の降順」に並べるための値。現行ファイルの
 * 選び方は JsonlTailManager と同じ経路 (projectsDirFor → encodeProjectDir →
 * pickLatestJsonl) を通すので、チャットビューが映している会話と同じファイルの
 * mtime になる。tmux の session_activity は端末の再描画でも動くので使わない。
 *
 * 1 秒間隔の polling (getAllPreviews) から呼ばれるため、失敗は黙って null に
 * する (pickLatestJsonl と同じ作法。ログ洪水を作らない)。
 *
 * polling の重さは実測した (2026-09-18、実データ 7 セッション)。1 tick の合計は
 * 定常 0.22ms・起動直後 0.89ms で、最大のディレクトリ (24 files) でも 0.13ms。
 * 1 ディレクトリに 500 files を置いた合成でも約 0.9ms だったので、ディレクトリ
 * 単位のメモ化は入れていない。1 セッションあたり数百 files まで育つ環境が出たら
 * (7 セッション × 0.9ms で 5ms を超える)、そこで初めて足す。
 */

import fs from "node:fs";
import path from "node:path";
import {
  encodeProjectDir,
  pickLatestJsonl,
  projectsDirFor,
} from "./claude-projects.js";

/** fs を差し替えてテストするための入出力 */
export interface TranscriptIo {
  /** ディレクトリ内の現行 .jsonl を選ぶ。無ければ null */
  pickLatestJsonl(dir: string, expectedCwd: string): string | null;
  /** ファイルの mtime (epochミリ秒) */
  statMtimeMs(file: string): number;
}

const defaultIo: TranscriptIo = {
  pickLatestJsonl,
  statMtimeMs: file => fs.statSync(file).mtimeMs,
};

/**
 * worktree + configDir の現行 JSONL の mtime (epochミリ秒)。
 * ディレクトリが無い・JSONL が無い・stat が失敗した場合は null (不明)。
 */
export function readTranscriptLastUpdatedAt(
  worktreePath: string,
  configDir: string | null | undefined,
  io: TranscriptIo = defaultIo
): number | null {
  // 復元時に pane_current_path を取れなかったセッションは worktreePath が空になる。
  // 空のまま進むと pickLatestJsonl が cwd 検証なしで projects 直下を見てしまうため弾く
  if (!worktreePath) return null;
  try {
    const dir = path.join(
      projectsDirFor(configDir),
      encodeProjectDir(worktreePath)
    );
    const file = io.pickLatestJsonl(dir, worktreePath);
    if (!file) return null;
    const mtimeMs = io.statMtimeMs(file);
    return Number.isFinite(mtimeMs) ? mtimeMs : null;
  } catch {
    return null;
  }
}
