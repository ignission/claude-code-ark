/**
 * Cloudflare Tunnel Manager
 *
 * Quick TunnelとNamed Tunnelの両方をサポート。
 * - Quick Tunnel: `cloudflared tunnel --url` で即座に公開URLを生成（設定不要）
 * - Named Tunnel: 事前設定されたトンネルを使用（固定URL）
 *
 * Named Tunnel は metrics の `/ready` を定期的に確認し、接続 0 本が続いたら
 * cloudflared を張り直す (#452)。Quick Tunnel は張り直すと URL が変わるため対象外。
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import {
  createLineSplitter,
  TunnelHealthMonitor,
  type TunnelProbeResult,
} from "./tunnel-health-monitor.js";

/** トンネルモード */
export type TunnelMode = "quick" | "named";

/** Named Tunnel用のオプション */
export interface NamedTunnelOptions {
  /** トンネル名（cloudflaredで作成したトンネル名） */
  tunnelName: string;
  /** 公開URL（例: https://ark.example.com） */
  publicUrl: string;
}

/** Named Tunnel の死活監視の設定 */
export interface TunnelHealthCheckOptions {
  /** `/ready` を確認する間隔 (デフォルト: 30秒) */
  intervalMs?: number;
  /** この時間以上接続 0 本が続いたら張り直す (デフォルト: 2分) */
  unhealthyThresholdMs?: number;
}

/** TunnelManagerの初期化オプション */
export interface TunnelManagerOptions {
  /** ローカルポート番号 */
  localPort: number;
  /** トンネルモード（デフォルト: 'quick'） */
  mode?: TunnelMode;
  /** Named Tunnel用のオプション（mode='named'の場合に必須） */
  namedTunnelOptions?: NamedTunnelOptions;
  /** Named Tunnel の死活監視の設定 */
  healthCheck?: TunnelHealthCheckOptions;
  /** cloudflared のパス (未指定なら PATH などから探す) */
  cloudflaredPath?: string;
}

export interface TunnelManagerEvents {
  url: [url: string];
  error: [error: Error];
  close: [code: number | null];
  /** Named Tunnel を張り直した */
  restart: [url: string];
}

const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 30_000;
const DEFAULT_UNHEALTHY_THRESHOLD_MS = 120_000;
/** SIGTERM 後にこの時間で終了しなければ SIGKILL する */
const TERMINATE_GRACE_MS = 10_000;
/** cloudflared が metrics の既定として試すポート。運用手順もこの番号を前提にしている */
const PREFERRED_METRICS_PORTS = [20241, 20242, 20243, 20244, 20245];

export class TunnelManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private publicUrl: string | null = null;
  private localPort: number;
  private mode: TunnelMode;
  private namedTunnelOptions?: NamedTunnelOptions;
  private cloudflaredPathOverride?: string;
  private healthCheckIntervalMs: number;
  private unhealthyThresholdMs: number;
  private healthMonitor: TunnelHealthMonitor | null = null;
  private metricsPort: number | null = null;
  /** stop() が呼ばれた後は張り直さない */
  private stopped = false;

  /**
   * TunnelManagerを作成
   * @param options - ポート番号またはオプションオブジェクト
   */
  constructor(options: number | TunnelManagerOptions) {
    super();

    // 後方互換性: 数値の場合はQuick Tunnelモード
    if (typeof options === "number") {
      this.localPort = options;
      this.mode = "quick";
      this.healthCheckIntervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS;
      this.unhealthyThresholdMs = DEFAULT_UNHEALTHY_THRESHOLD_MS;
    } else {
      this.localPort = options.localPort;
      this.mode = options.mode ?? "quick";
      this.namedTunnelOptions = options.namedTunnelOptions;
      this.cloudflaredPathOverride = options.cloudflaredPath;
      this.healthCheckIntervalMs =
        options.healthCheck?.intervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
      this.unhealthyThresholdMs =
        options.healthCheck?.unhealthyThresholdMs ??
        DEFAULT_UNHEALTHY_THRESHOLD_MS;

      // Named Tunnelモードの場合、オプションが必須
      if (this.mode === "named" && !this.namedTunnelOptions) {
        throw new Error(
          "Named Tunnelモードの場合、namedTunnelOptionsが必須です"
        );
      }
    }
  }

  /**
   * トンネルを開始
   * modeに応じてQuick TunnelまたはNamed Tunnelを起動
   */
  async start(): Promise<string> {
    if (this.process) {
      throw new Error("Tunnel already running");
    }
    this.stopped = false;

    if (this.mode === "named") {
      const url = await this.startNamedTunnel();
      this.startHealthMonitor();
      return url;
    }
    return this.startQuickTunnel();
  }

  /**
   * Quick Tunnelを開始
   * `cloudflared tunnel --url` で一時的な公開URLを生成
   */
  private async startQuickTunnel(): Promise<string> {
    return new Promise((resolve, reject) => {
      const cloudflaredPath = this.findCloudflared();
      if (!cloudflaredPath) {
        reject(this.createCloudflaredNotFoundError());
        return;
      }

      // cloudflaredをQuick Tunnelモードで起動
      // --config /dev/null で既存の設定ファイルを無視（Named Tunnel設定との競合を防ぐ）
      const child = spawn(cloudflaredPath, [
        "tunnel",
        "--config",
        "/dev/null",
        "--url",
        `http://localhost:${this.localPort}`,
      ]);
      this.process = child;

      let urlFound = false;
      const timeout = setTimeout(() => {
        if (!urlFound) {
          reject(new Error("Timeout waiting for tunnel URL"));
          this.stop();
        }
      }, 30000);

      // cloudflaredはURLをstderrに出力する
      // 形式: https://xxxxx.trycloudflare.com
      this.forwardOutput(child, line => {
        if (urlFound) return;
        const urlMatch = line.match(
          /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
        );
        if (urlMatch) {
          urlFound = true;
          clearTimeout(timeout);
          this.publicUrl = urlMatch[0];
          this.emit("url", this.publicUrl);
          resolve(this.publicUrl);
        }
      });

      child.on("error", error => {
        clearTimeout(timeout);
        this.emit("error", error);
        reject(error);
      });

      child.on("close", code => {
        clearTimeout(timeout);
        if (this.process === child) {
          this.process = null;
          this.publicUrl = null;
        }
        this.emit("close", code);
        if (!urlFound) {
          reject(new Error(`cloudflared exited with code ${code}`));
        }
      });
    });
  }

  /**
   * Named Tunnelを開始
   * `cloudflared tunnel --metrics <addr> run <tunnelName>` で事前設定されたトンネルを起動
   */
  private async startNamedTunnel(): Promise<string> {
    if (!this.namedTunnelOptions) {
      throw new Error("Named Tunnel options are required");
    }

    const { tunnelName, publicUrl } = this.namedTunnelOptions;
    const cloudflaredPath = this.findCloudflared();
    if (!cloudflaredPath) {
      throw this.createCloudflaredNotFoundError();
    }

    // 死活監視で /ready を叩くため metrics のアドレスを固定して渡す。
    // 未指定だと cloudflared が空きポートを自分で選び、Ark から辿れない。
    const metricsPort = await findAvailableMetricsPort();
    this.metricsPort = metricsPort;
    console.log(
      `[Tunnel] cloudflared metrics: http://127.0.0.1:${metricsPort}/ready`
    );

    return new Promise((resolve, reject) => {
      // cloudflaredをNamed Tunnelモードで起動
      // --metrics は run ではなく tunnel サブコマンドのフラグ
      const child = spawn(cloudflaredPath, [
        "tunnel",
        "--metrics",
        `127.0.0.1:${metricsPort}`,
        "run",
        tunnelName,
      ]);
      this.process = child;

      let connected = false;
      // Named Tunnelは起動に時間がかかる場合があるため、タイムアウトを長めに設定
      const timeout = setTimeout(() => {
        if (!connected) {
          reject(
            new Error(
              `Timeout waiting for tunnel connection (tunnel: ${tunnelName})`
            )
          );
          // 張り直し中でも監視は止めず、このプロセスだけ落とす
          child.kill("SIGTERM");
        }
      }, 60000);

      // "Registered tunnel connection" が出力されたら接続成功
      this.forwardOutput(child, line => {
        if (!connected && line.includes("Registered tunnel connection")) {
          connected = true;
          clearTimeout(timeout);
          this.publicUrl = publicUrl;
          this.emit("url", this.publicUrl);
          resolve(this.publicUrl);
        }
      });

      child.on("error", error => {
        clearTimeout(timeout);
        this.emit("error", error);
        reject(error);
      });

      child.on("close", code => {
        clearTimeout(timeout);
        // 張り直しで新しいプロセスに置き換わった後に古いプロセスの close が
        // 来ても、新しいほうを消さない
        if (this.process === child) {
          this.process = null;
          this.publicUrl = null;
        }
        this.emit("close", code);
        if (!connected) {
          reject(
            new Error(
              `cloudflared exited with code ${code} (tunnel: ${tunnelName})`
            )
          );
        }
      });
    });
  }

  /** Named Tunnel の死活監視を開始する */
  private startHealthMonitor(): void {
    if (this.healthMonitor) return;
    this.healthMonitor = new TunnelHealthMonitor({
      probe: () => this.probeReady(),
      onUnhealthy: () => this.restartNamedTunnel(),
      intervalMs: this.healthCheckIntervalMs,
      unhealthyThresholdMs: this.unhealthyThresholdMs,
    });
    this.healthMonitor.start();
  }

  /** cloudflared の `/ready` を確認する。接続が 1 本以上あれば 200 が返る */
  private async probeReady(): Promise<TunnelProbeResult> {
    if (!this.process || this.metricsPort === null) {
      return { healthy: false, detail: "cloudflared が起動していません" };
    }
    const response = await fetch(`http://127.0.0.1:${this.metricsPort}/ready`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = (await response.text()).trim();
    return {
      healthy: response.ok,
      detail: `/ready ${response.status} ${body}`.trim(),
    };
  }

  /** cloudflared を落として起動し直す */
  private async restartNamedTunnel(): Promise<void> {
    const old = this.process;
    if (old) {
      await terminateProcess(old);
    }
    if (this.stopped) return;

    const url = await this.startNamedTunnel();
    console.log(`[Tunnel] Named Tunnel を張り直しました: ${url}`);
    this.emit("restart", url);
  }

  /** cloudflared の出力を行単位で pm2 のログに流しつつ onLine に渡す */
  private forwardOutput(
    child: ChildProcess,
    onLine: (line: string) => void
  ): void {
    const handleLine = (line: string) => {
      console.log(`[cloudflared] ${line}`);
      onLine(line);
    };
    const stdout = createLineSplitter(handleLine);
    const stderr = createLineSplitter(handleLine);
    child.stdout?.on("data", (data: Buffer) => stdout.push(data.toString()));
    child.stderr?.on("data", (data: Buffer) => stderr.push(data.toString()));
    child.stdout?.on("end", () => stdout.flush());
    child.stderr?.on("end", () => stderr.flush());
  }

  /**
   * トンネルを停止
   */
  stop(): void {
    this.stopped = true;
    this.healthMonitor?.stop();
    this.healthMonitor = null;
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
      this.publicUrl = null;
    }
  }

  /**
   * 公開URLを取得
   */
  getUrl(): string | null {
    return this.publicUrl;
  }

  /**
   * トンネルが実行中かどうかを確認
   */
  isRunning(): boolean {
    return this.process !== null;
  }

  /**
   * 現在のトンネルモードを取得
   */
  getMode(): TunnelMode {
    return this.mode;
  }

  /**
   * cloudflaredバイナリを探す
   */
  private findCloudflared(): string | null {
    if (this.cloudflaredPathOverride) {
      return this.cloudflaredPathOverride;
    }

    // よくあるパスをチェック
    const paths = [
      "cloudflared", // PATH内
      "/usr/local/bin/cloudflared",
      "/opt/homebrew/bin/cloudflared",
      `${process.env.HOME}/.local/bin/cloudflared`,
    ];

    for (const path of paths) {
      try {
        execSync(`which ${path} 2>/dev/null || test -f ${path}`, {
          stdio: "ignore",
        });
        return path;
      } catch {}
    }

    // whichコマンドで探す
    try {
      const result = execSync("which cloudflared", { encoding: "utf-8" });
      return result.trim();
    } catch {
      return null;
    }
  }

  /**
   * cloudflaredが見つからない場合のエラーを作成
   */
  private createCloudflaredNotFoundError(): Error {
    return new Error(
      "cloudflared not found. Install it:\n" +
        "  macOS: brew install cloudflared\n" +
        "  Linux: See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    );
  }
}

/** 指定ポートで 127.0.0.1 を listen できるか試し、実際に取れたポートを返す */
function tryListen(port: number): Promise<number | null> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual =
        typeof address === "object" && address ? address.port : null;
      server.close(() => resolve(actual));
    });
  });
}

/**
 * metrics 用のポートを選ぶ。
 * cloudflared の既定と同じ 20241〜20245 を優先し、すべて埋まっていれば空きポートを使う。
 * 明示した --metrics が使用中だと cloudflared は起動に失敗するため、事前に確かめる。
 */
export async function findAvailableMetricsPort(
  preferred: readonly number[] = PREFERRED_METRICS_PORTS
): Promise<number> {
  for (const port of preferred) {
    if ((await tryListen(port)) !== null) return port;
  }
  const ephemeral = await tryListen(0);
  if (ephemeral === null) {
    throw new Error("cloudflared metrics 用の空きポートが見つかりません");
  }
  return ephemeral;
}

/** SIGTERM で終了を待ち、猶予を過ぎたら SIGKILL する */
function terminateProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, TERMINATE_GRACE_MS);
    child.once("close", () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
