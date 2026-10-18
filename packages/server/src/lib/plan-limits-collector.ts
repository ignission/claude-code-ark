/**
 * Plan Limits Collector
 *
 * セッションのプロファイルのプランの使用量 (5時間枠と週枠) を定期的に読む。
 * 会話の入力欄の横に出し、枠を使い切る前に気づけるようにする。
 *
 * - Claude Code の `/usage` と同じAPI (`/api/oauth/usage`) を、プロファイルの
 *   `<configDir>/.credentials.json` のアクセストークンで読む。公開のAPIではないので、
 *   形が変わったら黙ってその枠を null にするだけにする
 * - トークンの更新はしない。リフレッシュトークンは1回しか使えず、claudeと奪い合うと
 *   セッションの認証が切れる。期限切れのトークンでは読まず、前の値を残す
 *   (claudeが動けば更新され、次の巡回で読める)
 * - 読むのはセッションがあるプロファイルだけ。プロファイルは直列に読み、間隔は2分
 * - 失敗 (ネットワーク、401など) では前の値を残す。リセット時刻を過ぎた枠は出さない
 *   (古い値が残ったまま枠が替わると、使っていない枠を使ったと見せてしまう)
 * - 画面は読まない (`usage-collector.ts` はtmuxで `/usage` を開いて読むが、
 *   こちらは常に出すので、セッションを起動しない方法で読む)
 */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PlanLimits, PlanLimitWindow } from "@ark/shared";

export const PLAN_LIMITS_INTERVAL_MS = 120_000;
const FETCH_TIMEOUT_MS = 10_000;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** 使用量APIを読む。成功ならJSON、失敗なら理由 */
export type UsageFetcher = (
  token: string
) => Promise<{ ok: true; body: unknown } | { ok: false; message: string }>;

export const fetchUsage: UsageFetcher = async token => {
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
};

/** プロファイル未指定のセッションが使う設定ディレクトリ */
export function defaultConfigDir(): string {
  return path.join(os.homedir(), ".claude");
}

function parseWindow(raw: unknown): PlanLimitWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const { utilization, resets_at } = raw as Record<string, unknown>;
  if (typeof utilization !== "number" || !Number.isFinite(utilization))
    return null;
  return {
    percent: Math.min(Math.max(utilization, 0), 100),
    resetsAt: typeof resets_at === "string" ? resets_at : null,
  };
}

/** 使用量APIの応答を読む。形が違う枠は null */
export function parseUsage(body: unknown): PlanLimits {
  const obj =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    fiveHour: parseWindow(obj.five_hour),
    sevenDay: parseWindow(obj.seven_day),
  };
}

/** リセット時刻を過ぎた枠を落とす。両方とも無ければ null */
export function dropExpired(
  limits: PlanLimits,
  now: number
): PlanLimits | null {
  const live = (w: PlanLimitWindow | null) =>
    w && (w.resetsAt === null || Date.parse(w.resetsAt) > now) ? w : null;
  const fiveHour = live(limits.fiveHour);
  const sevenDay = live(limits.sevenDay);
  return fiveHour || sevenDay ? { fiveHour, sevenDay } : null;
}

/** `.credentials.json` のアクセストークン。無い、期限切れ、は理由を返す */
export async function readAccessToken(
  configDir: string,
  now: number
): Promise<{ token: string } | { skip: string }> {
  let raw: string;
  try {
    raw = await readFile(path.join(configDir, ".credentials.json"), "utf8");
  } catch {
    return { skip: "credentials が無い" };
  }
  try {
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    const token = oauth?.accessToken;
    if (typeof token !== "string" || !token) return { skip: "トークンが無い" };
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now)
      return { skip: "トークンの期限切れ" };
    return { token };
  } catch {
    return { skip: "credentials を読めない" };
  }
}

export class PlanLimitsCollector {
  /** configDir → 最後に読めた使用量 */
  private readonly cache = new Map<string, PlanLimits>();
  /** configDir → 最後の失敗。同じ失敗を毎回ログに出さない */
  private readonly lastError = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly fetcher: UsageFetcher,
    /** セッションがあるプロファイルの設定ディレクトリ */
    private readonly configDirs: () => string[],
    private readonly now: () => number = Date.now
  ) {}

  /** 設定ディレクトリの使用量。読めていない、枠がリセット済み、は null */
  get(configDir: string): PlanLimits | null {
    const limits = this.cache.get(configDir);
    return limits ? dropExpired(limits, this.now()) : null;
  }

  start(): void {
    if (this.timer) return;
    void this.collect();
    this.timer = setInterval(
      () => void this.collect(),
      PLAN_LIMITS_INTERVAL_MS
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 全プロファイルを1巡読む。前の巡回が終わっていなければ何もしない */
  async collect(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const dirs = new Set(this.configDirs());
      for (const dir of this.cache.keys()) {
        if (!dirs.has(dir)) this.cache.delete(dir);
      }
      for (const dir of this.lastError.keys()) {
        if (!dirs.has(dir)) this.lastError.delete(dir);
      }
      for (const dir of dirs) {
        const message = await this.read(dir);
        if (message === null) {
          this.lastError.delete(dir);
          continue;
        }
        if (this.lastError.get(dir) !== message) {
          console.warn(
            `[PlanLimits] ${dir} の使用量を読めない (前の値を残す): ${message}`
          );
        }
        this.lastError.set(dir, message);
      }
    } finally {
      this.running = false;
    }
  }

  /** 1つのプロファイルを読む。読めたら null、読めなければ理由 */
  private async read(configDir: string): Promise<string | null> {
    const credential = await readAccessToken(configDir, this.now());
    if ("skip" in credential) return credential.skip;
    const result = await this.fetcher(credential.token);
    if (!result.ok) return result.message;
    this.cache.set(configDir, parseUsage(result.body));
    return null;
  }
}
