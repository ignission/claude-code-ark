/**
 * Bridge Data Collector
 *
 * tmux capture-pane の最新出力からセッションの状態 (TOOL/THINK/AWAITING/IDLE/ERR) と
 * 「現在やっていること」の1行サマリ、ライブストリーム用の構造化行を抽出する。
 *
 * Bridge ダッシュボード専用の解析ロジック。既存 SessionOrchestrator の
 * getAllPreviews と似ているが、Bridge 用に「最後の数行」をストリームとして
 * 並べる必要があるためここに別実装する。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import type {
  BridgeSession,
  BridgeSessionStatus,
  BridgeStreamLine,
  BridgeTunnelEntry,
  SessionGridSnapshot,
} from "../../shared/types.js";
import { stripAnsi } from "./ansi.js";
import { db } from "./database.js";
import { sessionOrchestrator } from "./session-orchestrator.js";
import { tmuxManager } from "./tmux-manager.js";

/** capture-pane を独自フォーマットでパースした結果 */
interface PaneAnalysis {
  status: BridgeSessionStatus;
  currentTask: string;
  streamLines: BridgeStreamLine[];
}

/**
 * Bridge 用にセッション一覧を組み立てる。
 *
 * 主UI（Dashboard）の表示と一貫させるため、2段の同期を行う:
 *
 *   1. `sessionOrchestrator.getAllSessions()` で worktree 削除済みセッションを自動クリーンアップ
 *   2. settings DB の `repoList` キー（主UIサイドバーの表示対象リポジトリ）でフィルタ
 *
 * `repoList` が未設定（≒ 主UI未訪問）の場合は全件返す。
 * `tmuxManager.getAllSessions()` を直接使うと孤立セッション + 非表示リポジトリのセッションも混ざる。
 */
export function collectBridgeSessions(): BridgeSession[] {
  const managedSessions = sessionOrchestrator.getAllSessions();
  const allowedRepos = readUserRepoList();
  const filtered =
    allowedRepos === null
      ? managedSessions
      : managedSessions.filter(ms => {
          if (ms.repoPath) return allowedRepos.has(ms.repoPath);
          // legacy session (repoPath 未設定): repo 境界を意識した判定でフィルタ。
          // 単純な startsWith だと "app" が "app-old" などの兄弟 repo にも誤マッチする
          return Array.from(allowedRepos).some(r =>
            isWorktreeOfRepo(ms.worktreePath, r)
          );
        });
  const result: BridgeSession[] = [];
  for (const ms of filtered) {
    // 可視範囲のみ取得 (scrollback を含めると /clear 後でも過去ログが残り、
    // READY 判定や preview 表示が壊れる)
    const raw = tmuxManager.capturePaneVisible(ms.id);
    const analysis = raw ? analyzePane(raw) : EMPTY_ANALYSIS;
    const paneId = lookupPaneId(ms.tmuxSessionName);
    const previewText = raw ? extractPreviewText(raw, 12) : "";
    let status: BridgeSessionStatus;
    if (ms.status === "stopped") {
      status = "STOP";
    } else if (analysis.status === "IDLE" && previewText.trim().length === 0) {
      // /clear 直後・起動直後など、画面に意味あるテキストがない場合は READY (グレー)
      status = "READY";
    } else {
      status = analysis.status;
    }
    result.push({
      id: ms.id,
      name: deriveDisplayName(ms.worktreePath, ms.repoPath),
      status,
      paneId,
      tokens: estimateTokens(raw),
      elapsedMs: Date.now() - new Date(ms.createdAt).getTime(),
      currentTask: analysis.currentTask,
      previewText,
    });
  }
  // 状態優先で並び替え (要対応 → 動作中 → 入力待ち → 空 → 停止)
  result.sort((a, b) => {
    const order: Record<BridgeSessionStatus, number> = {
      ERR: 0,
      AWAITING: 1,
      TOOL: 2,
      THINK: 3,
      IDLE: 4,
      READY: 5,
      STOP: 6,
    };
    return order[a.status] - order[b.status];
  });
  return result;
}

/**
 * 既に取得済みの capture-pane 出力から BridgeSessionStatus + 末尾プレビューを解析する。
 *
 * session-orchestrator から呼んで session:previews ペイロードに status を載せ、
 * Bridge と主 Dashboard の重複ポーリングを避けるためのヘルパー。
 *
 * raw は capturePaneVisible() の戻り値を渡すこと。scrollback 込みだと READY 判定が壊れる。
 */
export function analyzeBridgeStatus(
  raw: string,
  sessionStopped: boolean
): { status: BridgeSessionStatus; previewText: string } {
  const analysis = analyzePane(raw);
  const previewText = extractPreviewText(raw, 12);
  let status: BridgeSessionStatus;
  if (sessionStopped) {
    status = "STOP";
  } else if (analysis.status === "IDLE" && previewText.trim().length === 0) {
    status = "READY";
  } else {
    status = analysis.status;
  }
  return { status, previewText };
}

/**
 * フォーカス中セッションのライブストリームを取得する。
 * 直近 N 行を構造化して返す。
 */
export function collectStreamLines(
  sessionId: string,
  maxLines = 20
): BridgeStreamLine[] {
  const raw = tmuxManager.capturePane(sessionId, 400);
  if (!raw) return [];
  const analysis = analyzePane(raw);
  return analysis.streamLines.slice(-maxLines);
}

/**
 * 主 Dashboard の RepoGridView 用に、各セッションの状態 + 末尾プレビューを返す。
 *
 * collectBridgeSessions と同じく:
 *   - sessionOrchestrator 経由で孤立セッションをクリーンアップ
 *   - settings DB の repoList でフィルタ
 *
 * Bridge と異なる点:
 *   - プレビューは ANSI 除去済みの「プレーンテキスト」(改行込み)
 *   - 1メッセージで全セッション分を返す（フォーカス概念なし）
 */
export function collectGridSnapshots(maxLines = 12): SessionGridSnapshot[] {
  const managedSessions = sessionOrchestrator.getAllSessions();
  const allowedRepos = readUserRepoList();
  const filtered =
    allowedRepos === null
      ? managedSessions
      : managedSessions.filter(ms => {
          if (ms.repoPath) return allowedRepos.has(ms.repoPath);
          return Array.from(allowedRepos).some(r =>
            isWorktreeOfRepo(ms.worktreePath, r)
          );
        });

  const now = Date.now();
  const result: SessionGridSnapshot[] = [];
  for (const ms of filtered) {
    // 可視範囲のみ取得 (collectBridgeSessions と統一)
    const raw = tmuxManager.capturePaneVisible(ms.id);
    const analysis = raw ? analyzePane(raw) : EMPTY_ANALYSIS;
    const previewText = raw ? extractPreviewText(raw, maxLines) : "";
    // collectBridgeSessions と同じ READY 判定を適用
    let status: BridgeSessionStatus;
    if (ms.status === "stopped") {
      status = "STOP";
    } else if (analysis.status === "IDLE" && previewText.trim().length === 0) {
      status = "READY";
    } else {
      status = analysis.status;
    }
    result.push({
      sessionId: ms.id,
      repoPath: ms.repoPath ?? ms.worktreePath,
      name: deriveDisplayName(ms.worktreePath, ms.repoPath),
      status,
      previewText,
      currentTask: analysis.currentTask,
      elapsedMs: now - new Date(ms.createdAt).getTime(),
      capturedAt: now,
    });
  }
  return result;
}

/**
 * capture-pane の文字列から末尾 maxLines 行を抽出してプレーン文字列に整形する。
 * UI装飾行 (アニメーション、ステータスバー、起動ヘッダー等) は除外し、
 * クリーンな「ターミナル中身プレビュー」として返す。
 */
function extractPreviewText(raw: string, maxLines: number): string {
  const cleaned = stripAnsi(raw)
    .split("\n")
    .map(l => l.replace(/\s+$/, ""));
  // 末尾から非UI行を maxLines 集める
  const collected: string[] = [];
  for (let i = cleaned.length - 1; i >= 0 && collected.length < maxLines; i--) {
    const t = cleaned[i].trim();
    if (!t) continue;
    if (isUiLine(t)) continue;
    collected.push(cleaned[i]);
  }
  return collected.reverse().join("\n");
}

/**
 * Tunnel エントリを Cloudflare に問い合わせず、サーバ内の状態のみで構築する簡易版。
 * 真の cloudflared 統合は server/index.ts 側で activeTunnel から組み立てる。
 */
export function buildTunnelEntries(input: {
  /** 現在 active な Quick / Named tunnel の URL（無ければ null） */
  primaryUrl: string | null;
}): BridgeTunnelEntry[] {
  const entries: BridgeTunnelEntry[] = [];
  if (input.primaryUrl) {
    entries.push({
      name: "Gangway",
      host: extractHost(input.primaryUrl),
      status: "on",
      stat: "active",
    });
  } else {
    entries.push({
      name: "Gangway",
      host: "—",
      status: "off",
      stat: "down",
    });
  }
  return entries;
}

// ─────────────────────────────────────────────────────────────────
// 内部
// ─────────────────────────────────────────────────────────────────

const EMPTY_ANALYSIS: PaneAnalysis = {
  status: "IDLE",
  currentTask: "",
  streamLines: [],
};

/**
 * settings DB の `repoList` キーを読む。
 *
 * - 値が配列でない / 空 / 未設定 → null（フィルタしない＝全件表示）
 * - 配列なら Set<string> として返す
 *
 * 主UI（Dashboard）が `setSetting("repoList", paths)` で書き込んでいる値を、
 * Bridge は読み取り専用で参照する。
 */
/**
 * worktreePath が repoPath の worktree (本体 or 兄弟ディレクトリ) かを判定する。
 *
 * 単純な `worktreePath.startsWith(repoPath)` だと "app" と "app-old" が誤マッチする。
 * クライアント側 sessionUtils.ts の isSessionBelongsToRepo と同等のロジック:
 *   1. 完全一致 (本体)
 *   2. 親ディレクトリが一致 + worktree名が "<repo名>-..." で始まる (兄弟 worktree)
 */
function isWorktreeOfRepo(worktreePath: string, repoPath: string): boolean {
  if (worktreePath === repoPath) return true;
  const repoParent = path.dirname(repoPath);
  const repoName = path.basename(repoPath);
  const worktreeParent = path.dirname(worktreePath);
  const worktreeName = path.basename(worktreePath);
  return (
    worktreeParent === repoParent && worktreeName.startsWith(`${repoName}-`)
  );
}

function readUserRepoList(): Set<string> | null {
  try {
    const raw = db.getSetting("repoList");
    // 未設定/型不正 → null (= フィルタなし、全件表示)
    if (!Array.isArray(raw)) return null;
    // 空配列はユーザーが「全 repo を非表示にした」状態を表すため、
    // 空 Set を返してすべてのセッションを除外する。
    // (useGroupedWorktreeItems の repoListEmpty 分岐と同じ意味づけ)
    return new Set(raw.filter((p): p is string => typeof p === "string"));
  } catch {
    return null;
  }
}

/**
 * 表示名を作る。
 *
 * 優先順位:
 *   1. worktreePath が repoPath と異なる（= worktree branch）→ worktree basename
 *   2. それ以外（メインブランチ or repoPath 不明）→ repo basename
 *
 * 例:
 *   worktreePath=/.../promarche-feat-x, repoPath=/.../promarche → "promarche-feat-x"
 *   worktreePath=/.../tally,            repoPath=/.../tally    → "tally"
 */
function deriveDisplayName(
  worktreePath: string,
  repoPath?: string | null
): string {
  if (repoPath && worktreePath !== repoPath) {
    return path.basename(worktreePath) || worktreePath;
  }
  return path.basename(repoPath || worktreePath) || worktreePath;
}

/** tmux list-panes で先頭ペインの %ID を取得（取れなければ null） */
function lookupPaneId(tmuxSessionName: string): string | null {
  try {
    const r = spawnSync(
      "tmux",
      ["list-panes", "-t", tmuxSessionName, "-F", "%#{pane_index}"],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    if (r.status !== 0) return null;
    const first = (r.stdout ?? "").split("\n").find(Boolean);
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

/**
 * tmux capture-pane の文字列を解析し、
 *   1. 状態 (TOOL/THINK/AWAITING/IDLE/ERR)
 *   2. 現在タスク（最終非UI行）
 *   3. ライブストリーム表示用に分類した行配列
 * を返す。
 *
 * Claude Code v2 (2.x) の出力形式に対応:
 *   - ⏺ <Tool>(...)        ツール呼び出し
 *   - ⎿ <result> / Error:  ツール結果 / エラー
 *   - ✻ Wibbling… (...esc) 思考中 (gerund)
 *   - ✻ Sautéed for 12s    完了 (過去形 + 経過時間)
 *   - ❯                    プロンプト
 *   - 1. Yes / 2. No       判断要メニュー
 */
function analyzePane(raw: string): PaneAnalysis {
  const lines = stripAnsi(raw)
    .split("\n")
    .map(l => l.replace(/\s+$/, ""));

  // ストリーム分類 (空行は除く)
  const streamLines: BridgeStreamLine[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    streamLines.push(classifyLine(t));
  }

  // 状態判定: 優先度順に判定する (高 → 低)
  // ERR > AWAITING > TOOL > THINK > IDLE
  const tail = lines.slice(-50);
  const status = detectStatus(tail);

  // 現在タスク: 末尾から非UI行を探す
  let currentTask = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    if (isUiLine(t)) continue;
    if (/^❯/.test(t)) continue;
    currentTask = t.length > 80 ? `${t.slice(0, 78)}…` : t;
    break;
  }

  return { status, currentTask, streamLines };
}

/**
 * 末尾 N 行から現在状態を判定する。
 * 各検知器は独立に評価し、優先度順に返す。
 */
function detectStatus(tail: string[]): BridgeSessionStatus {
  // 1. ERR — Claude セッション自体が壊れているケースのみ
  // 注意: 単純な "panic!"/"fatal:"/"Error:" 部分一致だと、Claude が編集中の
  // ソースコードに含まれる文字列まで拾って誤検知する (このコード自体がトリガー
  // になった)。ここでは:
  //   - 直近 10 行に限定
  //   - 行頭の panicked at / Segmentation fault / 行頭 ⎿ Error: のみ
  // をシグナルにする。1回失敗しただけのツール結果は ERR にしない。
  const recent = tail.slice(-10);
  const hasError = recent.some(l =>
    /^\s*(panicked at|Segmentation fault|Aborted)\b/.test(l)
  );
  if (hasError) return "ERR";

  // 2. AWAITING — ユーザー判断待ち
  // 数字付きメニュー (1. ... / 2. ...) が連続2行以上、または
  // y/n プロンプト、許可確認文言
  if (detectAwaiting(tail)) return "AWAITING";

  // 3. アクティブ判定
  // Claude Code はアクティブな進行中の行に必ず `…` + ` (経過時間 · ...)` を付ける:
  //   "✻ Wibbling… (4s · 23 tokens · esc to interrupt)"
  //   "✶ Jitterbugging… (14m 32s · ↓ 42.8k tokens)"
  //   "✢ 動作確認を実行中… (11m 9s · ↓ 26.7k tokens · almost done thinking)"
  // 先頭アイコンは ✻ ✽ ✢ ✶ ✵ * ● 等いろいろ変わるので「アイコン無依存」で判定する。
  // 完了形 "✻ Sautéed for 12s" や、純粋な省略 "Reading 1 file…" は対象外
  // (前者は … を持たない、後者は … の後にカッコ付き時間が来ない)。
  const isActive = tail.some(l => /…\s*\(\d+\w*/.test(l));
  if (isActive) {
    // ツール実行中 vs 純粋な思考中 を区別:
    //   最後の ⏺ ToolName( が、最後の ⎿ 結果より新しければ TOOL
    //   そうでなければ THINK
    let lastToolIdx = -1;
    let lastResultIdx = -1;
    for (let i = 0; i < tail.length; i++) {
      const l = tail[i];
      if (/^\s*⏺\s+[A-Z][a-zA-Z_]*\(/.test(l)) lastToolIdx = i;
      if (/^\s*⎿/.test(l)) lastResultIdx = i;
    }
    return lastToolIdx > lastResultIdx ? "TOOL" : "THINK";
  }

  // 4. それ以外は IDLE (DONE は廃止し IDLE に統合)
  return "IDLE";
}

/**
 * ユーザー判断待ち (AWAITING) の検出。
 *
 * 注意: 単純に "連続する `<digit>.` 行" でメニュー判定すると、Claude が
 * チャット中で生成した番号付きタスクリスト (例: テスト観点 1〜6) も拾って
 * 誤検知する。Claude Code の本物の確認 UI に固有のフレーズだけを見る。
 *
 * 真陽性を狙うフレーズ (実装時点の Claude Code v2 の許諾 UI 由来):
 *   - "Do you want to ...?" (Edit/Bash の許諾)
 *   - "Tool use approval required"
 *   - "(y/n)" / "[Y/n]" / "[y/N]"
 *   - "Allow Claude to" / "Deny" のような選択肢ヘッダ
 */
function detectAwaiting(tail: string[]): boolean {
  // 直近 15 行に絞って探す (古い発話に含まれる質問文での誤発火を避ける)
  const window = tail.slice(-15);
  return window.some(l =>
    /\(y\/n\)|\[y\/N\]|\[Y\/n\]|Do you want to|Tool use approval|approval required/i.test(
      l
    )
  );
}

function classifyLine(t: string): BridgeStreamLine {
  // プロンプト行 (❯ U+276F)
  if (/^\s*❯/.test(t)) return { kind: "prompt", text: t };
  // ツール呼び出し: ⏺ ToolName(...)
  if (/^\s*⏺\s+[A-Z][a-zA-Z_]*\(/.test(t)) return { kind: "tool", text: t };
  // ツール結果のエラー
  if (/^\s*⎿\s+(Error|Failed|Killed):/.test(t))
    return { kind: "error", text: t };
  // ツール結果 (一般)
  if (/^\s*⎿/.test(t)) return { kind: "result", text: t };
  // 思考中インジケータ (… の後にカッコ付き経過時間)
  if (/…\s*\(\d+\w*/.test(t)) return { kind: "think", text: t };
  // 既存マークも残す (古い出力の後方互換)
  if (/^\s*✓/.test(t)) return { kind: "ok", text: t };
  // ✗ で始まるエラーマーク (panic!/Error: の部分一致は誤検知が多いので除外)
  if (/^\s*✗/.test(t)) return { kind: "error", text: t };
  return { kind: "text", text: t };
}

/**
 * Claude Code UI 装飾行の判定。
 * session-orchestrator.ts の getAllPreviews と同等の判定だが、Bridge では
 * 部分的にしか使わないので簡易版を持つ。
 */
function isUiLine(line: string): boolean {
  if (/[✢✻▘▝▛▜▐▌█]/.test(line)) return true;
  if (line.includes("Sautéed for")) return true;
  if (line.includes("Baked for")) return true;
  if (line.includes("⏵")) return true;
  if (line.includes("bypass permissions")) return true;
  if (line.includes("shift+tab to cycle")) return true;
  if (line.includes("almost done thinking")) return true;
  // 番号付きリストの行除外は撤廃。Claude が生成した短い箇条書き
  // (例: "1. ファイルを読む") まで preview から消えてしまい、
  // READY を誤判定していた。AWAITING (許諾メニュー) は detectAwaiting() で
  // 別途検出されるためここで preview から外す必要はない。
  // プロンプト行 (❯ で始まる行は中身があってもユーザー入力エリアなので UI 扱い)
  if (/^❯/.test(line)) return true;
  // 他シェルの空プロンプト
  if (/^[>$%#]\s*$/.test(line)) return true;
  if (/^[─━═▔▁]{3,}$/.test(line)) return true;
  // Welcome バナーの枠線 (╭─── Claude Code v2.x ───╮ / ╰───╯)
  if (/^[╭╮╯╰][─═]/.test(line)) return true;
  if (/^[│║]/.test(line)) return true;
  if (/^Claude Code\s/.test(line)) return true;
  if (/context\)/.test(line) && /Opus|Sonnet|Haiku/.test(line)) return true;
  if (/^[~/][\w.\-/]+$/.test(line)) return true;
  if (/^\/[a-z][\w-]*$/.test(line)) return true;
  if (line.includes("(no content)")) return true;
  if (/^[└├│]/.test(line)) return true;
  return false;
}

/**
 * トークン数の概算。capture-pane の本文文字数を雑に 1/4 してトークン換算する。
 * 真のトークンカウントは jsonl 読み込みが必要だが、Bridge では「桁感」が
 * 出れば十分なので簡易見積もりに留める。
 */
function estimateTokens(raw: string | null): number {
  if (!raw) return 0;
  const stripped = stripAnsi(raw).replace(/\s+/g, " ");
  return Math.round(stripped.length / 4);
}

function extractHost(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url;
  }
}

// re-export 用（server/index.ts から呼びやすくするため）
export const bridgeCollector = {
  collectSessions: collectBridgeSessions,
  collectStreamLines,
  buildTunnelEntries,
};
