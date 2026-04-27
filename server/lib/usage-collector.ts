/**
 * Usage Collector
 *
 * 全プロファイルの `claude /usage` 結果を順次取得する。
 *
 * tmux一時セッション (`ark-usage-*`) でclaude CLIを起動し、`/usage` コマンドを
 * 送信、`tmux capture-pane` で出力をパースする。各プロファイルは直列実行する。
 *
 * 直列実行の理由:
 *   同時に複数の claude CLIを別 CLAUDE_CONFIG_DIR で起動すると、
 *   (a) Anthropic API側のレート制限を瞬間的に複数同時消費、
 *   (b) `.credentials.json` への並行アクセス、
 *   (c) tmuxサーバーへの同時アクセス競合、
 *   (d) 各claudeが同時にトークンリフレッシュした場合の認証競合
 *   を引き起こす可能性があるため、確実性を優先して直列実行する。
 */

import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Profile,
  UsageEntry,
  UsageProgress,
  UsageReport,
} from "../../shared/types.js";
import { stripAnsi } from "./ansi.js";

/**
 * 起動完了検出のアンカー文字列（claude CLIのメインプロンプト）
 *
 * `❯` 単独は trust dialog (`❯ 1. Yes, I trust this folder`) でも出現するため
 * 必ず「ヘルプ表記が画面下部にある」状態 = `for shortcuts` で判定する。
 */
const READY_ANCHORS = ["for shortcuts"];

/** オンボーディング画面検出のアンカー文字列（未認証 / 初回起動） */
const ONBOARDING_ANCHORS = [
  "Welcome to Claude Code",
  "Let's get started",
  "Choose the text style",
];

/**
 * 「Trust this folder」ダイアログ検出のアンカー文字列。
 * profile毎に trust 状態は独立しているため、新規プロファイルでは必ず出現する。
 * 検出したら「1」+ Enter を送って自動承諾する。
 */
const TRUST_DIALOG_ANCHORS = ["trust this folder", "Quick safety check"];

/** capture-paneの取得行数（/usage画面 + ヘッダ余裕分） */
const CAPTURE_LINES = 300;

/** ポーリング間隔（ミリ秒） */
const POLL_INTERVAL_MS = 200;

/**
 * claude起動完了待ちの最大時間。
 * trust dialog 自動承諾後の再描画も含めるため余裕を持たせる
 * (素の起動: 4秒前後, trust 後再描画含む: ~8秒)
 */
const READY_TIMEOUT_MS = 10_000;

/** /usage結果待ちの最大時間 */
const USAGE_RESULT_TIMEOUT_MS = 5_000;

/** 1プロファイルあたりの全体タイムアウト（起動 + 送信 + 結果待ち） */
const TOTAL_TIMEOUT_MS = 15_000;

/** /usage結果に必要な "% used" の出現回数（session, weekly all, weekly sonnet） */
const REQUIRED_USAGE_MARKERS = 3;

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * `tmux capture-pane` の生出力から /usage の数値情報をパースする。
 * 認証済みプランの典型的な出力形式に対応。
 */
export function parseUsage(raw: string): UsageEntry["parsed"] | null {
  const stripped = stripAnsi(raw);

  // 各セクションを「アンカー → 次のアンカー or 末尾まで」で抽出
  const sectionMatch = (anchor: string, nextAnchors: string[]): string => {
    const startIdx = stripped.indexOf(anchor);
    if (startIdx === -1) return "";
    const sliceStart = startIdx + anchor.length;
    let endIdx = stripped.length;
    for (const next of nextAnchors) {
      const idx = stripped.indexOf(next, sliceStart);
      if (idx !== -1 && idx < endIdx) endIdx = idx;
    }
    return stripped.slice(sliceStart, endIdx);
  };

  const sessionSection = sectionMatch("Current session", [
    "Current week (all models)",
    "Current week (Sonnet only)",
  ]);
  const weeklyAllSection = sectionMatch("Current week (all models)", [
    "Current week (Sonnet only)",
  ]);
  const weeklySonnetSection = sectionMatch("Current week (Sonnet only)", []);

  /**
   * セクションから percent / resets を抽出する。
   * Resets行は optional (Team プランで Sonnet 使用率 0% の場合は表示されない)。
   */
  const extractSection = (
    section: string,
    requireResets: boolean
  ): { percent: number; resets: string } | null => {
    if (!section) return null;
    const percentMatch = /(\d+)% used/.exec(section);
    if (!percentMatch) return null;
    const resetsMatch = /Resets\s+([^\n\r]+)/.exec(section);
    if (requireResets && !resetsMatch) return null;
    return {
      percent: Number.parseInt(percentMatch[1], 10),
      resets: resetsMatch ? resetsMatch[1].trim() : "",
    };
  };

  // Session と weekly all は必須・Resets も必須
  const session = extractSection(sessionSection, true);
  const weeklyAll = extractSection(weeklyAllSection, true);
  // Sonnet only は Resets が任意 (0% 時は表示されない Team プラン仕様)
  const weeklySonnet = extractSection(weeklySonnetSection, false);

  if (!session || !weeklyAll || !weeklySonnet) return null;

  const totalCostMatch = /Total cost:\s+(\$[\d.]+)/.exec(stripped);
  // 「1m 7s」「2h 3m」のような複数トークン値を切り詰めないよう行末まで取る
  const wallDurationMatch = /Total duration \(wall\):\s+([^\n\r]+)/.exec(
    stripped
  );

  return {
    sessionPercent: session.percent,
    weeklyAllPercent: weeklyAll.percent,
    weeklySonnetPercent: weeklySonnet.percent,
    sessionResets: session.resets,
    weeklyAllResets: weeklyAll.resets,
    weeklySonnetResets: weeklySonnet.resets,
    totalCost: totalCostMatch ? totalCostMatch[1] : undefined,
    wallDuration: wallDurationMatch ? wallDurationMatch[1].trim() : undefined,
  };
}

/** オンボーディング画面（未認証）であるかを判定する */
export function isOnboardingScreen(raw: string): boolean {
  const stripped = stripAnsi(raw);
  return ONBOARDING_ANCHORS.some(anchor => stripped.includes(anchor));
}

/** claude CLIの起動完了（プロンプト表示）を判定する */
export function isReadyScreen(raw: string): boolean {
  const stripped = stripAnsi(raw);
  return READY_ANCHORS.some(anchor => stripped.includes(anchor));
}

/**
 * 「Trust this folder」ダイアログが表示されているかを判定する。
 * 新規プロファイルでは必ず1回出るので、自動承諾する想定。
 */
export function isTrustDialog(raw: string): boolean {
  const stripped = stripAnsi(raw);
  return TRUST_DIALOG_ANCHORS.some(anchor => stripped.includes(anchor));
}

/**
 * /usage 結果が画面に表示されているかを判定する。
 *
 * 描画途中の検出を避けるため、(a) `% used` が3つ揃い、(b) Sonnet only セクションの
 * 前にある `Resets` 行が2つ以上揃っていること、を要求する。
 *
 * 注: Sonnet only セクションは Team プランで 0% 利用時に Resets 行が表示されない
 * ため、3つ目の Resets は要求しない。代わりに Sonnet 区画の見出しが見えていれば
 * 描画完了とみなす。
 */
export function hasUsageResult(raw: string): boolean {
  const stripped = stripAnsi(raw);
  const usedMatches = stripped.match(/% used/g);
  const resetsMatches = stripped.match(/Resets\s+/g);
  if ((usedMatches?.length ?? 0) < REQUIRED_USAGE_MARKERS) return false;
  // Sonnet only 区画の見出しが描画されていることを確認
  if (!stripped.includes("Current week (Sonnet only)")) return false;
  // Session + weekly all の Resets は必ず存在する
  return (resetsMatches?.length ?? 0) >= 2;
}

/** UsageCollectorの依存（テスト時に差し替え可能にする） */
export interface UsageCollectorDeps {
  tmuxExec: (args: string[]) => {
    status: number | null;
    stdout: string;
    stderr: string;
  };
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: UsageCollectorDeps = {
  tmuxExec: args => {
    const r = spawnSync("tmux", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      status: r.status,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  },
  now: () => Date.now(),
  sleep,
};

export class UsageCollector extends EventEmitter {
  private deps: UsageCollectorDeps;

  constructor(deps?: Partial<UsageCollectorDeps>) {
    super();
    this.deps = { ...defaultDeps, ...deps };
  }

  /** 全プロファイルの /usage を順次取得する */
  async collect(profiles: Profile[]): Promise<UsageReport> {
    const entries: UsageEntry[] = [];
    const total = profiles.length;

    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i];
      // 開始時: 「i 件完了済み、これから profile.name を処理開始」
      this.emit("usage:progress", {
        currentProfileName: profile.name,
        completed: i,
        total,
      });

      const entry = await this.collectOne(profile);
      entries.push(entry);

      // 完了時: 「i+1 件完了」(typed event を信頼する consumer 用に正確な
      // completed 件数も配信。最後のループ終了時に completed=total が届く)
      this.emit("usage:progress", {
        currentProfileName: profile.name,
        completed: i + 1,
        total,
      });
    }

    return {
      entries,
      collectedAt: this.deps.now(),
    };
  }

  /** 1プロファイル分の /usage を取得する */
  async collectOne(profile: Profile): Promise<UsageEntry> {
    const sessionName = `ark-usage-${profile.id}-${this.deps.now()}`;
    const startedAt = this.deps.now();
    const baseEntry: Omit<UsageEntry, "status"> = {
      profileId: profile.id,
      profileName: profile.name,
      configDir: profile.configDir,
    };

    // claude を HOME で起動すると trust 自動承諾が「HOME 全体」に
    // 永続化されてしまい、後続の通常 Claude セッションで HOME 配下の
    // 任意のリポジトリの trust 確認がスキップされる副作用があるため、
    // 毎回ユニークな一時ディレクトリを作って起動する。一時ディレクトリは
    // finally で削除するので trust state は実質無害（存在しないパスへの
    // trust エントリが該当 CLAUDE_CONFIG_DIR に残るが、参照されることはない）。
    //
    // mkdtempSync は try ブロック内で呼ぶ。/tmp 書き込み失敗等の例外で
    // collect() ループ全体を中断させず、当該プロファイルだけ error にする。
    let cwd: string | null = null;

    try {
      cwd = mkdtempSync(path.join(os.tmpdir(), "ark-usage-"));
      // configDir が空文字 = デフォルトプロファイル指定。
      // CLAUDE_CONFIG_DIR を明示すると、たとえ ~/.claude を指していても claude が
      // 「カスタム設定」扱いし、テーマ未選択のオンボーディング画面が出てしまう
      // (テーマ等の状態は設定ディレクトリ外に保存されているため)。デフォルト
      // 動作を再現するには CLAUDE_CONFIG_DIR を渡さない方が確実。
      const useDefault = profile.configDir === "";
      const envArgs: string[] = [
        "-e",
        "CLAUDECODE=",
        "-e",
        "CLAUDE_CODE_NO_FLICKER=1",
      ];
      if (!useDefault) {
        envArgs.push("-e", `CLAUDE_CONFIG_DIR=${profile.configDir}`);
      }

      // 重要: claude を直接 new-session の引数として渡すと、CLAUDECODE 検出等で
      // claude が即座に終了した場合 tmux がセッションを破棄してしまう
      // (capture-pane で "can't find pane" エラー)。tmux-manager.ts と同じく、
      // シェルを起動してから claude コマンドを send-keys で送る方式にする。
      const newSession = this.deps.tmuxExec([
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-c",
        cwd,
        ...envArgs,
      ]);
      if (newSession.status !== 0) {
        return {
          ...baseEntry,
          status: "error",
          errorMessage: `tmux new-session failed (status: ${newSession.status}, stderr: ${newSession.stderr.trim()})`,
        };
      }

      // シェル起動後に claude を送信
      const sendClaude = this.deps.tmuxExec([
        "send-keys",
        "-t",
        sessionName,
        "claude",
        "Enter",
      ]);
      if (sendClaude.status !== 0) {
        return {
          ...baseEntry,
          status: "error",
          errorMessage: `claude起動コマンド送信失敗 (stderr: ${sendClaude.stderr.trim()})`,
        };
      }

      const readyResult = await this.waitForReady(
        sessionName,
        startedAt + READY_TIMEOUT_MS
      );

      if (readyResult === "onboarding") {
        return {
          ...baseEntry,
          status: "unauthenticated",
        };
      }

      if (readyResult === "timeout") {
        return {
          ...baseEntry,
          status: "timeout",
          errorMessage: "claude CLIの起動を検出できませんでした",
        };
      }

      const sendResult = this.deps.tmuxExec([
        "send-keys",
        "-t",
        sessionName,
        "/usage",
        "Enter",
      ]);
      if (sendResult.status !== 0) {
        return {
          ...baseEntry,
          status: "error",
          errorMessage: "/usage 送信に失敗しました",
        };
      }

      const overallDeadline = Math.min(
        startedAt + TOTAL_TIMEOUT_MS,
        this.deps.now() + USAGE_RESULT_TIMEOUT_MS
      );
      const captured = await this.waitForUsageResult(
        sessionName,
        overallDeadline
      );

      if (!captured) {
        return {
          ...baseEntry,
          status: "timeout",
          errorMessage: "/usage 結果が時間内に表示されませんでした",
        };
      }

      const parsed = parseUsage(captured);
      if (!parsed) {
        return {
          ...baseEntry,
          status: "error",
          errorMessage: "/usage 出力のパースに失敗しました",
          rawOutput:
            process.env.NODE_ENV === "development" ? captured : undefined,
        };
      }

      return {
        ...baseEntry,
        status: "ok",
        parsed,
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ...baseEntry,
        status: "error",
        errorMessage: message,
      };
    } finally {
      try {
        this.deps.tmuxExec(["kill-session", "-t", sessionName]);
      } catch {
        // already gone
      }
      if (cwd) {
        try {
          rmSync(cwd, { recursive: true, force: true });
        } catch {
          // tmpdir削除失敗は無視（次回起動時にOSが自動掃除する）
        }
      }
    }
  }

  /**
   * claude CLIの起動完了を待つ。
   * Trust dialog ("Quick safety check") が出た場合は自動承諾 (1 + Enter) する。
   * @returns "ready" / "onboarding" / "timeout"
   */
  private async waitForReady(
    sessionName: string,
    deadline: number
  ): Promise<"ready" | "onboarding" | "timeout"> {
    let trustAccepted = false;
    while (this.deps.now() < deadline) {
      await this.deps.sleep(POLL_INTERVAL_MS);
      const captured = this.capturePane(sessionName);
      if (captured === null) continue;
      if (isOnboardingScreen(captured)) return "onboarding";
      if (isReadyScreen(captured)) return "ready";
      // Trust dialog: 1 (= "Yes, I trust this folder") + Enter で自動承諾。
      // 1度送ったら以降の繰り返しでは無視（連打しない）。プロファイル毎に
      // CLAUDE_CONFIG_DIR が独立しているため、新規プロファイルでは必ず通る。
      if (!trustAccepted && isTrustDialog(captured)) {
        this.deps.tmuxExec(["send-keys", "-t", sessionName, "1", "Enter"]);
        trustAccepted = true;
      }
    }
    return "timeout";
  }

  /** /usage結果の表示を待つ */
  private async waitForUsageResult(
    sessionName: string,
    deadline: number
  ): Promise<string | null> {
    while (this.deps.now() < deadline) {
      await this.deps.sleep(POLL_INTERVAL_MS);
      const captured = this.capturePane(sessionName);
      if (captured === null) continue;
      if (hasUsageResult(captured)) return captured;
    }
    return null;
  }

  private capturePane(sessionName: string): string | null {
    const r = this.deps.tmuxExec([
      "capture-pane",
      "-t",
      sessionName,
      "-p",
      "-S",
      `-${CAPTURE_LINES}`,
    ]);
    if (r.status !== 0) return null;
    return r.stdout;
  }
}
