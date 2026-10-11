/**
 * Named Tunnel の死活監視
 *
 * cloudflared はプロセスが生きたまま edge への登録に失敗し続けることがあり
 * (#452)、close イベントだけでは劣化を検知できない。metrics の `/ready` を
 * 定期的に叩き、不健全な状態が閾値を超えて続いたら onUnhealthy (張り直し) を呼ぶ。
 */

/** probe の結果 */
export interface TunnelProbeResult {
  healthy: boolean;
  /** ログ用の補足 (HTTP ステータスやエラー内容) */
  detail: string;
}

export interface TunnelHealthMonitorOptions {
  /** 健全性を確認する。throw した場合は不健全として扱う */
  probe: () => Promise<TunnelProbeResult>;
  /** 不健全が閾値を超えて続いたときに呼ぶ (張り直し) */
  onUnhealthy: () => Promise<void>;
  /** probe の間隔 */
  intervalMs: number;
  /** この時間以上連続して不健全なら onUnhealthy を呼ぶ */
  unhealthyThresholdMs: number;
  /** テスト用の時計 */
  now?: () => number;
}

export class TunnelHealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private unhealthySince: number | null = null;
  private inFlight = false;
  private readonly now: () => number;

  constructor(private readonly options: TunnelHealthMonitorOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.unhealthySince = null;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs);
    // 監視タイマーだけでプロセスを生かし続けない
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unhealthySince = null;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /** 1 回分の確認。張り直し中や前回の probe 待ちの間は何もしない */
  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      let result: TunnelProbeResult;
      try {
        result = await this.options.probe();
      } catch (error) {
        result = {
          healthy: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      // probe 待ちの間に stop された
      if (!this.timer) return;

      if (result.healthy) {
        if (this.unhealthySince !== null) {
          console.log(`[Tunnel] 接続が回復しました (${result.detail})`);
        }
        this.unhealthySince = null;
        return;
      }

      const now = this.now();
      if (this.unhealthySince === null) {
        this.unhealthySince = now;
        console.warn(`[Tunnel] 接続が不健全です (${result.detail})`);
      }
      if (now - this.unhealthySince < this.options.unhealthyThresholdMs) {
        return;
      }

      console.warn(
        `[Tunnel] 不健全な状態が ${Math.round((now - this.unhealthySince) / 1000)} 秒続いたため張り直します (${result.detail})`
      );
      try {
        await this.options.onUnhealthy();
      } catch (error) {
        console.error(
          "[Tunnel] 張り直しに失敗しました:",
          error instanceof Error ? error.message : String(error)
        );
      }
      // 張り直しの成否にかかわらず、次の判定は閾値ぶん待ってから行う
      this.unhealthySince = null;
    } finally {
      this.inFlight = false;
    }
  }
}

/**
 * チャンク単位の出力を行単位に分割する。
 * 改行が来ないまま溜まり続けないよう、maxBufferedChars を超えたら吐き出す。
 */
export function createLineSplitter(
  onLine: (line: string) => void,
  maxBufferedChars = 64 * 1024
): { push: (chunk: string) => void; flush: () => void } {
  let buffer = "";
  const emit = (line: string) => {
    if (line.trim()) onLine(line);
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) emit(line);
      if (buffer.length > maxBufferedChars) {
        emit(buffer);
        buffer = "";
      }
    },
    flush() {
      emit(buffer);
      buffer = "";
    },
  };
}
