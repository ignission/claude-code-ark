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
 * - ghにログイン済みのアカウントを順に試す (有効なアカウントが先)。トークンは `GH_TOKEN` で渡し、
 *   `gh auth switch` は使わない (利用者の端末の有効なアカウントまで替わる)。
 *   読めたアカウントはworktreeごとに覚え、どのアカウントでも読めないworktreeは null にして、
 *   ログインしているアカウントの顔ぶれが変わるまで読まない
 * - それ以外の失敗 (タイムアウト、認証やネットワークの一時的な失敗) では前の値を残す。
 *   null にすると、次に読めた「落ちた」が初めて見た値になり、通知を取りこぼす
 * - ghが見つからなければ、この機能だけを無効にする (起動時に1行だけ知らせる)
 * - セッションは直列に読む。間隔は60秒。10セッションでも1時間に600回で、
 *   GitHub APIの上限 (5,000回/時) に収まる
 * - CodeRabbitはStatusContextで、レビューが終わるまでPENDINGのままになる。
 *   その間は「待ち」と出す (CodeRabbitが終わるまでが確認の範囲)
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
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

/**
 * ghを1回実行した結果。PRが無いと分かった (`none`)、そのアカウントではリポジトリが見えない
 * (`noaccess`)、読めなかった (`error`) を分ける
 */
export type GhResult =
  | { kind: "ok"; stdout: string }
  | { kind: "none" }
  | { kind: "noaccess" }
  | { kind: "error"; message: string };

/** token を渡すと、そのトークンで実行する (`GH_TOKEN`)。無ければghの有効なアカウント */
export type GhRunner = (
  cwd: string,
  args: string[],
  token?: string
) => Promise<GhResult>;

interface GhAccount {
  login: string;
  token: string;
}

/** PRが無いことを表すghのエラー。これ以外の失敗は一時的なものとみなす */
const NO_PR_PATTERNS = [
  "no pull requests found",
  "could not determine current branch",
  "none of the git remotes",
  "not a git repository",
];

/** アカウントにリポジトリが見えないときのghのエラー (権限が無いと、存在しないのと同じ応答になる) */
const NO_ACCESS_PATTERN = "could not resolve to a repository";

export function classifyGhError(stderr: string, message: string): GhResult {
  const text = `${stderr}\n${message}`.toLowerCase();
  if (NO_PR_PATTERNS.some(pattern => text.includes(pattern))) {
    return { kind: "none" };
  }
  if (text.includes(NO_ACCESS_PATTERN)) return { kind: "noaccess" };
  return {
    kind: "error",
    message: (stderr.trim() || message).split("\n")[0] ?? "",
  };
}

export function createGhRunner(ghPath: string): GhRunner {
  return (cwd, args, token) =>
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
            ...(token ? { GH_TOKEN: token } : {}),
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
  /** worktreeごとの読めたアカウント。null はどのアカウントでも読めない */
  private readonly accountOf = new Map<string, string | null>();
  /** accountOf を決めたときのアカウントの顔ぶれ。変わったら決め直す */
  private accountsKey = "";
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
      const accounts = await this.listAccounts();
      const key = accounts.map(a => a.login).join(",");
      if (key !== this.accountsKey) {
        this.accountsKey = key;
        this.accountOf.clear();
      }
      const paths = new Set(targets.map(t => t.worktreePath));
      for (const path of this.accountOf.keys()) {
        if (!paths.has(path)) this.accountOf.delete(path);
      }
      for (const target of targets) {
        const result = await this.read(target.worktreePath, accounts);
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
          result.kind === "ok" ? parsePrView(result.stdout) : null
        );
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * ghにログイン済みのgithub.comのアカウントとトークン (有効なアカウントが先)。
   * 取れなければ空で、そのときはトークンを渡さずに読む (ghの有効なアカウントで読む)
   */
  private async listAccounts(): Promise<GhAccount[]> {
    const cwd = homedir();
    const status = await this.run(cwd, ["auth", "status", "--json", "hosts"]);
    if (status.kind !== "ok") return [];
    let entries: Array<{ login?: unknown; active?: unknown; state?: unknown }>;
    try {
      const hosts = JSON.parse(status.stdout)?.hosts?.["github.com"];
      entries = Array.isArray(hosts) ? hosts : [];
    } catch {
      return [];
    }
    const logins = entries
      .filter(e => typeof e.login === "string" && e.state === "success")
      .sort((a, b) => Number(b.active === true) - Number(a.active === true))
      .map(e => e.login as string);
    const accounts: GhAccount[] = [];
    for (const login of logins) {
      const token = await this.run(cwd, [
        "auth",
        "token",
        "--hostname",
        "github.com",
        "--user",
        login,
      ]);
      if (token.kind === "ok" && token.stdout.trim()) {
        accounts.push({ login, token: token.stdout.trim() });
      }
    }
    return accounts;
  }

  /** worktreeのPRを読む。覚えたアカウントから試し、見えなければ次のアカウントへ */
  private async read(
    worktreePath: string,
    accounts: GhAccount[]
  ): Promise<GhResult> {
    const args = ["pr", "view", "--json", GH_FIELDS];
    if (accounts.length === 0) {
      const result = await this.run(worktreePath, args);
      return result.kind === "noaccess" ? { kind: "none" } : result;
    }
    const known = this.accountOf.get(worktreePath);
    if (known === null) return { kind: "none" };
    const ordered = known
      ? [
          ...accounts.filter(a => a.login === known),
          ...accounts.filter(a => a.login !== known),
        ]
      : accounts;
    for (const account of ordered) {
      const result = await this.run(worktreePath, args, account.token);
      if (result.kind === "noaccess") continue;
      if (result.kind !== "error")
        this.accountOf.set(worktreePath, account.login);
      return result;
    }
    console.warn(
      `[PrStatus] ${worktreePath} はghのどのアカウントからも見えないので、PRを出さない`
    );
    this.accountOf.set(worktreePath, null);
    return { kind: "none" };
  }
}
