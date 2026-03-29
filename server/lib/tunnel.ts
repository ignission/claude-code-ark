/**
 * Cloudflare Tunnel Manager
 *
 * Quick TunnelとNamed Tunnelの両方をサポート。
 * - Quick Tunnel: `cloudflared tunnel --url` で即座に公開URLを生成（設定不要）
 * - Named Tunnel: 事前設定されたトンネルを使用（固定URL）
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

/** トンネルモード */
export type TunnelMode = "quick" | "named";

/** Named Tunnel用のオプション */
export interface NamedTunnelOptions {
  /** トンネル名（cloudflaredで作成したトンネル名） */
  tunnelName: string;
  /** 公開URL（例: https://ccm.example.com） */
  publicUrl: string;
}

/** TunnelManagerの初期化オプション */
export interface TunnelManagerOptions {
  /** ローカルポート番号 */
  localPort: number;
  /** トンネルモード（デフォルト: 'quick'） */
  mode?: TunnelMode;
  /** Named Tunnel用のオプション（mode='named'の場合に必須） */
  namedTunnelOptions?: NamedTunnelOptions;
}

export interface TunnelManagerEvents {
  url: [url: string];
  error: [error: Error];
  close: [code: number | null];
}

export class TunnelManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private publicUrl: string | null = null;
  private localPort: number;
  private mode: TunnelMode;
  private namedTunnelOptions?: NamedTunnelOptions;

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
    } else {
      this.localPort = options.localPort;
      this.mode = options.mode ?? "quick";
      this.namedTunnelOptions = options.namedTunnelOptions;

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

    if (this.mode === "named") {
      return this.startNamedTunnel();
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
      this.process = spawn(cloudflaredPath, [
        "tunnel",
        "--config",
        "/dev/null",
        "--url",
        `http://localhost:${this.localPort}`,
      ]);

      let outputBuffer = "";
      let urlFound = false;
      const timeout = setTimeout(() => {
        if (!urlFound) {
          reject(new Error("Timeout waiting for tunnel URL"));
          this.stop();
        }
      }, 30000);

      this.process.stderr?.on("data", (data: Buffer) => {
        outputBuffer += data.toString();
        // cloudflaredはURLをstderrに出力する
        // 形式: https://xxxxx.trycloudflare.com
        const urlMatch = outputBuffer.match(
          /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
        );
        if (urlMatch && !urlFound) {
          urlFound = true;
          clearTimeout(timeout);
          this.publicUrl = urlMatch[0];
          this.emit("url", this.publicUrl);
          resolve(this.publicUrl);
        }
      });

      this.process.stdout?.on("data", (data: Buffer) => {
        // 念のためstdoutもチェック
        outputBuffer += data.toString();
      });

      this.process.on("error", error => {
        clearTimeout(timeout);
        this.emit("error", error);
        reject(error);
      });

      this.process.on("close", code => {
        clearTimeout(timeout);
        this.process = null;
        this.publicUrl = null;
        this.emit("close", code);
        if (!urlFound) {
          reject(new Error(`cloudflared exited with code ${code}`));
        }
      });
    });
  }

  /**
   * Named Tunnelを開始
   * `cloudflared tunnel run <tunnelName>` で事前設定されたトンネルを起動
   */
  private async startNamedTunnel(): Promise<string> {
    if (!this.namedTunnelOptions) {
      throw new Error("Named Tunnel options are required");
    }

    const { tunnelName, publicUrl } = this.namedTunnelOptions;

    return new Promise((resolve, reject) => {
      const cloudflaredPath = this.findCloudflared();
      if (!cloudflaredPath) {
        reject(this.createCloudflaredNotFoundError());
        return;
      }

      // cloudflaredをNamed Tunnelモードで起動
      this.process = spawn(cloudflaredPath, ["tunnel", "run", tunnelName]);

      let outputBuffer = "";
      let connected = false;
      // Named Tunnelは起動に時間がかかる場合があるため、タイムアウトを長めに設定
      const timeout = setTimeout(() => {
        if (!connected) {
          reject(
            new Error(
              `Timeout waiting for tunnel connection (tunnel: ${tunnelName})`
            )
          );
          this.stop();
        }
      }, 60000);

      const handleOutput = (data: Buffer) => {
        outputBuffer += data.toString();

        // "Registered tunnel connection" が出力されたら接続成功
        if (
          outputBuffer.includes("Registered tunnel connection") &&
          !connected
        ) {
          connected = true;
          clearTimeout(timeout);
          this.publicUrl = publicUrl;
          this.emit("url", this.publicUrl);
          resolve(this.publicUrl);
        }
      };

      this.process.stderr?.on("data", handleOutput);
      this.process.stdout?.on("data", handleOutput);

      this.process.on("error", error => {
        clearTimeout(timeout);
        this.emit("error", error);
        reject(error);
      });

      this.process.on("close", code => {
        clearTimeout(timeout);
        this.process = null;
        this.publicUrl = null;
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

  /**
   * トンネルを停止
   */
  stop(): void {
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
