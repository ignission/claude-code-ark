/**
 * PR Status Collector
 *
 * セッションのブランチに紐づくGitHubのPRと、そのチェックの集計を定期的に読む。
 * 一覧の行に通った / 落ちた / 待ちを出し、落ちたら通知するために使う
 * (「完了」だけでは成功と失敗が分からないので、CIの結果で外から補う)。
 *
 * - 読むだけで、PRやブランチには何も書かない。Auto-fixやAuto-mergeは持たない
 * - worktreeを cwd にして `gh pr view` を実行する。リポジトリとブランチはghが決める。
 *   PRが無い、detached HEAD、GitHubのリモートが無い、は null
 * - それ以外の失敗 (タイムアウト、認証やネットワークの一時的な失敗) では前の値を残す。
 *   null にすると、次に読めた「落ちた」が初めて見た値になり、通知を取りこぼす
 * - ghが見つからなければ、この機能だけを無効にする (起動時に1行だけ知らせる)
 * - セッションは直列に読む。間隔は60秒。10セッションでも1時間に600回で、
 *   GitHub APIの上限 (5,000回/時) に収まる
 * - CodeRabbitはStatusContextで、レビューが終わるまでPENDINGのままになる。
 *   その間は「待ち」と出す (CodeRabbitが終わるまでが確認の範囲)
 */

import { execFile } from "node:child_process";
import type { SessionPrStatus } from "@ark/shared";

export const PR_STATUS_INTERVAL_MS = 60_000;
const GH_TIMEOUT_MS = 20_000;
const GH_FIELDS = "number,url,state,isDraft,headRefOid,statusCheckRollup";

/** 落ちたとみなすチェックの結論 (CheckRunのconclusion / StatusContextのstate) */
const FAILED = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
/** 通ったとみなす結論。これ以外 (PENDING・EXPECTED・空) は終わっていない */
const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

interface RollupEntry {
  __typename?: string;
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
}

/** statusCheckRollupを1つの状態にまとめる */
export function summarizeChecks(rollup: unknown): SessionPrStatus["checks"] {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let pending = false;
  for (const raw of rollup as RollupEntry[]) {
    if (!raw || typeof raw !== "object") continue;
    // CheckRunは status が COMPLETED になってから conclusion が付く。
    // StatusContextは state だけを持つ
    const isCheckRun =
      raw.__typename === "CheckRun" ||
      (raw.status != null && raw.state == null);
    if (isCheckRun && raw.status !== "COMPLETED") {
      pending = true;
      continue;
    }
    const result = (isCheckRun ? raw.conclusion : raw.state) ?? "";
    if (FAILED.has(result)) return "failed";
    if (!PASSED.has(result)) pending = true;
  }
  return pending ? "pending" : "passed";
}

/** `gh pr view --json` の出力を読む。形が違えば null */
export function parsePrView(stdout: string): SessionPrStatus | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const { number, url, state, isDraft, headRefOid } = obj;
  if (
    typeof number !== "number" ||
    typeof url !== "string" ||
    (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED")
  ) {
    return null;
  }
  return {
    number,
    url,
    state,
    isDraft: isDraft === true,
    checks: summarizeChecks(obj.statusCheckRollup),
    headRefOid: typeof headRefOid === "string" ? headRefOid : "",
  };
}

export interface PrStatusTarget {
  sessionId: string;
  worktreePath: string;
}

/** ghを1回実行した結果。PRが無いと分かった (`none`) のと、読めなかった (`error`) を分ける */
export type GhResult =
  | { kind: "ok"; stdout: string }
  | { kind: "none" }
  | { kind: "error"; message: string };

export type GhRunner = (cwd: string, args: string[]) => Promise<GhResult>;

/** PRが無いことを表すghのエラー。これ以外の失敗は一時的なものとみなす */
const NO_PR_PATTERNS = [
  "no pull requests found",
  "could not determine current branch",
  "none of the git remotes",
  "not a git repository",
];

export function classifyGhError(stderr: string, message: string): GhResult {
  const text = `${stderr}\n${message}`.toLowerCase();
  if (NO_PR_PATTERNS.some(pattern => text.includes(pattern))) {
    return { kind: "none" };
  }
  return {
    kind: "error",
    message: (stderr.trim() || message).split("\n")[0] ?? "",
  };
}

export function createGhRunner(ghPath: string): GhRunner {
  return (cwd, args) =>
    new Promise(resolve => {
      execFile(
        ghPath,
        args,
        {
          cwd,
          timeout: GH_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            GH_PROMPT_DISABLED: "1",
            GH_NO_UPDATE_NOTIFIER: "1",
            NO_COLOR: "1",
          },
        },
        (error, stdout, stderr) =>
          resolve(
            error
              ? classifyGhError(String(stderr ?? ""), error.message)
              : { kind: "ok", stdout }
          )
      );
    });
}

export class PrStatusCollector {
  private readonly cache = new Map<string, SessionPrStatus | null>();
  /** セッションごとの最後の読み取りの失敗。同じ失敗を毎回ログに出さない */
  private readonly lastError = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly run: GhRunner,
    private readonly targets: () => PrStatusTarget[]
  ) {}

  /** セッションのPRの状態。まだ読んでいなければ null */
  get(sessionId: string): SessionPrStatus | null {
    return this.cache.get(sessionId) ?? null;
  }

  start(): void {
    if (this.timer) return;
    void this.collect();
    this.timer = setInterval(() => void this.collect(), PR_STATUS_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 全セッションを1巡読む。前の巡回が終わっていなければ何もしない */
  async collect(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const targets = this.targets();
      const alive = new Set(targets.map(t => t.sessionId));
      for (const id of this.cache.keys()) {
        if (!alive.has(id)) this.cache.delete(id);
      }
      for (const id of this.lastError.keys()) {
        if (!alive.has(id)) this.lastError.delete(id);
      }
      for (const target of targets) {
        const result = await this.run(target.worktreePath, [
          "pr",
          "view",
          "--json",
          GH_FIELDS,
        ]);
        if (result.kind === "error") {
          if (this.lastError.get(target.sessionId) !== result.message) {
            console.warn(
              `[PrStatus] ${target.worktreePath} を読めない (前の値を残す): ${result.message}`
            );
          }
          this.lastError.set(target.sessionId, result.message);
          continue;
        }
        this.lastError.delete(target.sessionId);
        this.cache.set(
          target.sessionId,
          result.kind === "none" ? null : parsePrView(result.stdout)
        );
      }
    } finally {
      this.running = false;
    }
  }
}
