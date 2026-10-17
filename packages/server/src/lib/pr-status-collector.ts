/**
 * PR Status Collector
 *
 * セッションのブランチに紐づくGitHubのPRと、そのチェックの集計を定期的に読む。
 * 一覧の行に通った / 落ちた / 待ちを出し、落ちたら通知するために使う
 * (「完了」だけでは成功と失敗が分からないので、CIの結果で外から補う)。
 *
 * - 読むだけで、PRやブランチには何も書かない。Auto-fixやAuto-mergeは持たない
 * - worktreeを cwd にして `gh pr view` を実行する。リポジトリとブランチはghが決める。
 *   PRが無い、detached HEAD、GitHubでないリモート、ghが認証されていない、はどれも null
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

/** ghを1回実行し、標準出力を返す。失敗 (PRが無い場合を含む) は null */
export type GhRunner = (cwd: string, args: string[]) => Promise<string | null>;

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
        (error, stdout) => resolve(error ? null : stdout)
      );
    });
}

export class PrStatusCollector {
  private readonly cache = new Map<string, SessionPrStatus | null>();
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
      for (const target of targets) {
        const stdout = await this.run(target.worktreePath, [
          "pr",
          "view",
          "--json",
          GH_FIELDS,
        ]);
        this.cache.set(
          target.sessionId,
          stdout === null ? null : parsePrView(stdout)
        );
      }
    } finally {
      this.running = false;
    }
  }
}
