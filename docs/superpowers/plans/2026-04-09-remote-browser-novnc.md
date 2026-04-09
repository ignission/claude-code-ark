# リモートブラウザタブ noVNC方式 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** リモートアクセス時にlocalhostアプリを完璧に表示するため、noVNC方式（Xvfb + Chromium + x11vnc + websockify）でブラウザ画面を転送する

**Architecture:** ポートごとにXvfb仮想ディスプレイ上でChromiumを起動し、x11vnc→websockify経由でnoVNC WebクライアントへVNC画面を転送する。既存のTtydManagerと同じEventEmitter+ポート管理パターンでBrowserManagerを実装し、SessionOrchestratorに統合する。

**Tech Stack:** Xvfb, Chromium, x11vnc, websockify (Python), noVNC (静的ファイル), Express/Socket.IO, React 19

**設計ドキュメント:** `docs/superpowers/specs/2026-04-09-remote-browser-novnc-design.md`

---

## ファイル構成

| ファイル | 操作 | 責務 |
|---------|------|------|
| `server/lib/constants.ts` | 変更 | VNC/WebSocketポート範囲定数を追加 |
| `shared/types.ts` | 変更 | BrowserSession型、Socket.IOイベント型を追加 |
| `server/lib/browser-manager.ts` | 新規 | Xvfb+Chromium+x11vnc+websockifyのプロセス管理 |
| `server/index.ts` | 変更 | `/browser/:browserId` プロキシルート、Socket.IOハンドラー追加 |
| `client/src/components/BrowserPane.tsx` | 変更 | ローカル/リモート自動切り替え、noVNC iframe表示 |
| `client/src/hooks/useSocket.ts` | 変更 | browser:* イベントのリッスンとアクション追加 |
| `scripts/setup-browser.sh` | 新規 | 依存パッケージインストールスクリプト |

---

### Task 1: 定数とBrowserSession型の定義

**Files:**
- Modify: `server/lib/constants.ts`
- Modify: `shared/types.ts`

- [ ] **Step 1: constants.tsにVNC/WebSocketポート範囲を追加**

`server/lib/constants.ts` の末尾に以下を追加:

```typescript
/** VNCポート範囲の開始ポート（x11vnc用） */
export const VNC_PORT_START = 5900;

/** VNCポート範囲の終了ポート */
export const VNC_PORT_END = 5999;

/** WebSocketポート範囲の開始ポート（websockify用） */
export const WS_PORT_START = 6080;

/** WebSocketポート範囲の終了ポート */
export const WS_PORT_END = 6179;

/** Xvfb仮想ディスプレイ番号の開始値 */
export const DISPLAY_START = 99;
```

- [ ] **Step 2: shared/types.tsにBrowserSession型を追加**

`shared/types.ts` の `ManagedSession` インターフェースの下に以下を追加:

```typescript
/**
 * noVNCブラウザセッション情報
 * リモートアクセス時にlocalhostアプリをnoVNC経由で表示するためのセッション
 */
export interface BrowserSession {
  /** セッション固有ID */
  id: string;
  /** 対象のlocalhostポート番号 */
  targetPort: number;
  /** 対象URL（オプション。未指定時はhttp://localhost:{targetPort}） */
  targetUrl: string;
  /** websockifyのポート番号 */
  wsPort: number;
  /** VNC(x11vnc)のポート番号 */
  vncPort: number;
  /** Xvfb仮想ディスプレイ番号 */
  displayNum: number;
  /** DevToolsを開いた状態で起動しているか */
  devtools: boolean;
  /** 作成日時 */
  createdAt: Date;
}
```

- [ ] **Step 3: shared/types.tsにSocket.IOイベント型を追加**

`ServerToClientEvents` インターフェースの `"file:content"` イベントの後に以下を追加:

```typescript
  // Browser session events（noVNCリモートブラウザ）
  "browser:started": (session: BrowserSession) => void;
  "browser:stopped": (data: { browserId: string }) => void;
  "browser:error": (data: { message: string }) => void;
```

`ClientToServerEvents` インターフェースの `"file:read"` イベントの後に以下を追加:

```typescript
  // Browser session commands（noVNCリモートブラウザ）
  "browser:start": (data: { port: number; url?: string; devtools?: boolean }) => void;
  "browser:stop": (data: { browserId: string }) => void;
```

- [ ] **Step 4: 型チェック実行**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm check`
Expected: 型エラーなし（新規型はまだどこからも参照されていないため）

- [ ] **Step 5: コミット**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager
git add server/lib/constants.ts shared/types.ts
git commit -m "feat: BrowserSession型とVNC/WSポート定数を追加"
```

---

### Task 2: BrowserManager実装

**Files:**
- Create: `server/lib/browser-manager.ts`

- [ ] **Step 1: BrowserManagerクラスを作成**

`server/lib/browser-manager.ts` を以下の内容で作成。

**注意:** 外部コマンドの存在チェックには `execFileSync` を使用する（`execSync` はシェルインジェクションリスクがあるため）。プロセス起動には `spawn` を使用する。

```typescript
/**
 * Browser Session Manager (noVNC方式)
 *
 * リモートアクセス時にlocalhostアプリをnoVNC経由で表示するため、
 * Xvfb + Chromium + x11vnc + websockify のプロセスセットを管理する。
 *
 * TtydManagerと同じEventEmitter+ポート管理パターンに従う。
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import type { BrowserSession } from "../../shared/types.js";
import {
  DISPLAY_START,
  VNC_PORT_END,
  VNC_PORT_START,
  WS_PORT_END,
  WS_PORT_START,
} from "./constants.js";

interface BrowserProcessSet {
  session: BrowserSession;
  xvfbProcess: ChildProcess;
  chromiumProcess: ChildProcess;
  x11vncProcess: ChildProcess;
  websockifyProcess: ChildProcess;
}

export class BrowserManager extends EventEmitter {
  private sessions: Map<string, BrowserProcessSet> = new Map();
  /** 同じポートへの重複起動を防ぐ */
  private pendingStarts: Map<string, Promise<BrowserSession>> = new Map();
  private nextVncPort: number;
  private nextWsPort: number;
  private nextDisplay: number;
  private available = false;

  constructor() {
    super();
    this.nextVncPort = VNC_PORT_START;
    this.nextWsPort = WS_PORT_START;
    this.nextDisplay = DISPLAY_START;
    this.available = this.checkDependencies();
  }

  /**
   * 必要な外部コマンドがインストールされているか確認
   * execFileSyncを使用（シェルインジェクション対策）
   */
  private checkDependencies(): boolean {
    let allFound = true;

    // Chromium系コマンドは複数の名前がある
    const chromiumCommands = ["chromium-browser", "chromium", "google-chrome"];
    const hasChromium = chromiumCommands.some(cmd => {
      try {
        execFileSync("which", [cmd], { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    });

    if (!hasChromium) {
      console.warn(
        "[BrowserManager] Chromium not found. Install: apt install chromium-browser"
      );
      allFound = false;
    }

    for (const cmd of ["Xvfb", "x11vnc", "websockify"]) {
      try {
        execFileSync("which", [cmd], { stdio: "pipe" });
      } catch {
        console.warn(
          `[BrowserManager] ${cmd} not found. Run: scripts/setup-browser.sh`
        );
        allFound = false;
      }
    }

    // noVNCの静的ファイルパスを確認
    try {
      this.findNoVncPath();
    } catch {
      console.warn(
        "[BrowserManager] noVNC not found. Run: scripts/setup-browser.sh"
      );
      allFound = false;
    }

    if (!allFound) {
      console.warn(
        "[BrowserManager] ブラウザタブ機能は無効です。依存パッケージをインストールしてください。"
      );
    }

    return allFound;
  }

  /** ブラウザタブ機能が利用可能か */
  isAvailable(): boolean {
    return this.available;
  }

  /** Chromiumの実行可能ファイル名を取得 */
  private getChromiumCommand(): string {
    for (const cmd of ["chromium-browser", "chromium", "google-chrome"]) {
      try {
        execFileSync("which", [cmd], { stdio: "pipe" });
        return cmd;
      } catch {
        continue;
      }
    }
    throw new Error("Chromium not found");
  }

  /** 指定ポートがOSレベルで使用可能かチェック */
  private checkPortAvailable(port: number): Promise<boolean> {
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        server.close();
        resolve(false);
      }, 3000);

      const server = net.createServer();
      server.once("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
      server.once("listening", () => {
        clearTimeout(timeout);
        server.close(() => resolve(true));
      });
      server.listen(port, "127.0.0.1");
    });
  }

  /** 利用可能なVNCポートを探す */
  private async findAvailableVncPort(): Promise<number> {
    const usedPorts = new Set(
      Array.from(this.sessions.values()).map(s => s.session.vncPort)
    );
    const totalPorts = VNC_PORT_END - VNC_PORT_START + 1;
    for (let i = 0; i < totalPorts; i++) {
      const port =
        VNC_PORT_START +
        ((this.nextVncPort - VNC_PORT_START + i) % totalPorts);
      if (usedPorts.has(port)) continue;
      const ok = await this.checkPortAvailable(port);
      if (!ok) continue;
      this.nextVncPort = port + 1;
      if (this.nextVncPort > VNC_PORT_END) this.nextVncPort = VNC_PORT_START;
      return port;
    }
    throw new Error("No available VNC ports");
  }

  /** 利用可能なWebSocketポートを探す */
  private async findAvailableWsPort(): Promise<number> {
    const usedPorts = new Set(
      Array.from(this.sessions.values()).map(s => s.session.wsPort)
    );
    const totalPorts = WS_PORT_END - WS_PORT_START + 1;
    for (let i = 0; i < totalPorts; i++) {
      const port =
        WS_PORT_START +
        ((this.nextWsPort - WS_PORT_START + i) % totalPorts);
      if (usedPorts.has(port)) continue;
      const ok = await this.checkPortAvailable(port);
      if (!ok) continue;
      this.nextWsPort = port + 1;
      if (this.nextWsPort > WS_PORT_END) this.nextWsPort = WS_PORT_START;
      return port;
    }
    throw new Error("No available WebSocket ports");
  }

  /** 利用可能なディスプレイ番号を探す */
  private findAvailableDisplay(): number {
    const usedDisplays = new Set(
      Array.from(this.sessions.values()).map(s => s.session.displayNum)
    );
    const maxDisplay = DISPLAY_START + 100;
    for (let d = this.nextDisplay; d < maxDisplay; d++) {
      if (!usedDisplays.has(d)) {
        this.nextDisplay = d + 1;
        if (this.nextDisplay >= maxDisplay) this.nextDisplay = DISPLAY_START;
        return d;
      }
    }
    for (let d = DISPLAY_START; d < this.nextDisplay; d++) {
      if (!usedDisplays.has(d)) return d;
    }
    throw new Error("No available display numbers");
  }

  /** noVNCの静的ファイルパスを探す */
  private findNoVncPath(): string {
    const candidates = [
      "/usr/share/novnc",
      "/usr/local/share/novnc",
      "/snap/novnc/current",
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    throw new Error("noVNC not found. Run: scripts/setup-browser.sh");
  }

  /**
   * ブラウザセッションを開始
   */
  async start(
    port: number,
    url?: string,
    devtools = false
  ): Promise<BrowserSession> {
    if (!this.available) {
      throw new Error(
        "ブラウザタブ機能は無効です。依存パッケージをインストールしてください。"
      );
    }

    // SSRF対策: URLバリデーション
    if (url) {
      const parsed = new URL(url);
      if (
        (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") ||
        (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      ) {
        throw new Error(
          "URLはlocalhost/127.0.0.1のhttp/httpsのみ許可されています"
        );
      }
    }

    // セッション数の上限チェック
    const MAX_SESSIONS = 10;
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(
        `ブラウザセッション数が上限(${MAX_SESSIONS})に達しています`
      );
    }

    // 同じポートへの重複起動を防ぐ
    const pendingKey = `port-${port}`;
    const pending = this.pendingStarts.get(pendingKey);
    if (pending) return pending;

    // 同じポートの既存セッションがあれば返す
    for (const ps of this.sessions.values()) {
      if (ps.session.targetPort === port) return ps.session;
    }

    const promise = this._startInternal(port, url, devtools);
    this.pendingStarts.set(pendingKey, promise);

    try {
      return await promise;
    } finally {
      this.pendingStarts.delete(pendingKey);
    }
  }

  /** 実際の起動処理（内部用） */
  private async _startInternal(
    targetPort: number,
    url?: string,
    devtools = false
  ): Promise<BrowserSession> {
    const browserId = `browser-${targetPort}-${Date.now()}`;
    const targetUrl = url || `http://localhost:${targetPort}`;
    const displayNum = this.findAvailableDisplay();
    const vncPort = await this.findAvailableVncPort();
    const wsPort = await this.findAvailableWsPort();
    const display = `:${displayNum}`;

    console.log(
      `[BrowserManager] Starting: port=${targetPort}, display=${display}, vnc=${vncPort}, ws=${wsPort}`
    );

    // 1. Xvfb起動
    const xvfbProcess = spawn(
      "Xvfb",
      [display, "-screen", "0", "1280x900x24", "-ac"],
      { stdio: ["ignore", "pipe", "pipe"], detached: false }
    );

    await new Promise<void>((resolve, reject) => {
      const earlyExit = (code: number | null) => {
        reject(new Error(`Xvfb exited early with code ${code}`));
      };
      xvfbProcess.on("error", err =>
        reject(new Error(`Xvfb failed: ${err.message}`))
      );
      xvfbProcess.once("exit", earlyExit);
      // Xvfbはready出力がないため短いディレイで判断
      setTimeout(() => {
        xvfbProcess.removeListener("exit", earlyExit);
        resolve();
      }, 500);
    });

    // 2. Chromium起動
    const chromiumCmd = this.getChromiumCommand();
    const chromiumArgs = [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-sync",
      "--disable-translate",
      "--no-first-run",
      "--disable-default-apps",
      "--window-size=1280,900",
      "--window-position=0,0",
    ];
    if (devtools) {
      chromiumArgs.push("--auto-open-devtools-for-tabs");
    }
    chromiumArgs.push(targetUrl);

    const chromiumProcess = spawn(chromiumCmd, chromiumArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      env: { ...process.env, DISPLAY: display },
    });

    // Chromiumの起動を待つ
    await new Promise<void>(resolve => setTimeout(resolve, 2000));

    // 3. x11vnc起動
    const x11vncProcess = spawn(
      "x11vnc",
      [
        "-display", display,
        "-rfbport", vncPort.toString(),
        "-listen", "127.0.0.1",
        "-shared",
        "-forever",
        "-nopw",
        "-noxdamage",
      ],
      { stdio: ["ignore", "pipe", "pipe"], detached: false }
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => resolve(), 5000);
      let output = "";
      x11vncProcess.stderr?.on("data", (data: Buffer) => {
        output += data.toString();
        if (output.includes("PORT=")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      x11vncProcess.on("error", err => {
        clearTimeout(timeout);
        reject(new Error(`x11vnc failed: ${err.message}`));
      });
    });

    // 4. websockify起動（--webでnoVNC静的ファイルを配信）
    const novncPath = this.findNoVncPath();
    const websockifyProcess = spawn(
      "websockify",
      [
        "--web", novncPath,
        `127.0.0.1:${wsPort}`,
        `127.0.0.1:${vncPort}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"], detached: false }
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => resolve(), 3000);
      let output = "";
      const onData = (data: Buffer) => {
        output += data.toString();
        if (output.includes("WebSocket") || output.includes("listening")) {
          clearTimeout(timeout);
          resolve();
        }
      };
      websockifyProcess.stdout?.on("data", onData);
      websockifyProcess.stderr?.on("data", onData);
      websockifyProcess.on("error", err => {
        clearTimeout(timeout);
        reject(new Error(`websockify failed: ${err.message}`));
      });
    });

    const session: BrowserSession = {
      id: browserId,
      targetPort,
      targetUrl,
      wsPort,
      vncPort,
      displayNum,
      devtools,
      createdAt: new Date(),
    };

    const processSet: BrowserProcessSet = {
      session,
      xvfbProcess,
      chromiumProcess,
      x11vncProcess,
      websockifyProcess,
    };

    this.sessions.set(browserId, processSet);

    // プロセスの異常終了を監視
    const watchExit = (name: string, proc: ChildProcess) => {
      proc.on("exit", code => {
        console.log(
          `[BrowserManager] ${name} for ${browserId} exited (code=${code})`
        );
        if (this.sessions.has(browserId)) {
          this.stop(browserId);
        }
      });
    };

    watchExit("Xvfb", xvfbProcess);
    watchExit("Chromium", chromiumProcess);
    watchExit("x11vnc", x11vncProcess);
    watchExit("websockify", websockifyProcess);

    this.emit("session:started", session);
    console.log(
      `[BrowserManager] Session started: ${browserId}`
    );

    return session;
  }

  /** ブラウザセッションを停止 */
  async stop(browserId: string): Promise<void> {
    const processSet = this.sessions.get(browserId);
    if (!processSet) return;

    // 逆順で停止（websockify → x11vnc → chromium → xvfb）
    // SIGTERM後に3秒待ち、まだ生存していればSIGKILLを送信
    for (const [name, proc] of [
      ["websockify", processSet.websockifyProcess],
      ["x11vnc", processSet.x11vncProcess],
      ["chromium", processSet.chromiumProcess],
      ["xvfb", processSet.xvfbProcess],
    ] as const) {
      try {
        const child = proc as ChildProcess;
        child.kill("SIGTERM");
        await new Promise<void>(resolve => {
          const timeout = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // already dead
            }
            resolve();
          }, 3000);
          child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      } catch (e) {
        console.warn(`[BrowserManager] Failed to kill ${name}: ${e}`);
      }
    }

    this.sessions.delete(browserId);

    this.emit("session:stopped", browserId);
    console.log(`[BrowserManager] Session stopped: ${browserId}`);
  }

  /** セッションIDで取得 */
  getSession(browserId: string): BrowserSession | undefined {
    return this.sessions.get(browserId)?.session;
  }

  /** 全セッションを取得 */
  getAllSessions(): BrowserSession[] {
    return Array.from(this.sessions.values()).map(ps => ps.session);
  }

  /** 全セッションを停止 */
  cleanup(): void {
    for (const browserId of Array.from(this.sessions.keys())) {
      this.stop(browserId);
    }
    console.log("[BrowserManager] Cleaned up all browser sessions");
  }
}

export const browserManager = new BrowserManager();
```

- [ ] **Step 2: 型チェック実行**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm check`
Expected: 型エラーなし

- [ ] **Step 3: コミット**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager
git add server/lib/browser-manager.ts
git commit -m "feat: BrowserManager（noVNC方式）を実装"
```

---

### Task 3: BrowserManagerのユニットテスト

**Files:**
- Create: `server/lib/__tests__/browser-manager.test.ts`

- [ ] **Step 1: テストファイルを作成**

`server/lib/__tests__/browser-manager.test.ts` を作成。vitestで記述し、外部コマンド（`spawn`, `execFileSync`）は `vi.mock` でモック化する。

テスト対象:
- `checkDependencies`: 全コマンドが存在する場合に `true` を返す / 一部欠損時に `false` を返す
- `isAvailable`: `checkDependencies` の結果を反映する
- `start`（モック）: URLバリデーション（localhostのみ許可、外部URL拒否）、セッション数上限チェック、正常起動でBrowserSessionが返る
- `stop`: セッションが削除される、SIGTERM→SIGKILLフォールバック
- `cleanup`: 全セッションが停止される
- ポート検索ロジック: 使用中ポートをスキップして次の空きポートを返す

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// spawn, execFileSyncをモック化
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    on: vi.fn(),
    once: vi.fn(),
    kill: vi.fn(),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    pid: 12345,
  })),
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn((p: string) => p === "/usr/share/novnc"),
  },
}));

// テスト内容は上記のテスト対象に従って実装する
```

- [ ] **Step 2: テスト実行**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm vitest run server/lib/__tests__/browser-manager.test.ts`
Expected: 全テストがパス

- [ ] **Step 3: コミット**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager
git add server/lib/__tests__/browser-manager.test.ts
git commit -m "test: BrowserManagerのユニットテストを追加"
```

---

### Task 4: サーバー側プロキシルートとSocket.IOハンドラー

**Files:**
- Modify: `server/index.ts`
- Modify: `server/lib/port-scanner.ts`

- [ ] **Step 1: browserManagerのimportを追加**

`server/index.ts` の先頭のimport文に以下を追加（`import { sessionOrchestrator }` の近く）:

```typescript
import { browserManager } from "./lib/browser-manager.js";
```

また、`constants.ts` のimportに新しい定数を追加:

```typescript
import {
  TTYD_PORT_END,
  TTYD_PORT_START,
  VNC_PORT_END,
  VNC_PORT_START,
  WS_PORT_END,
  WS_PORT_START,
} from "./lib/constants.js";
```

- [ ] **Step 2: `/browser/:browserId` HTTPプロキシルートを追加**

`server/index.ts` の ttyd proxy routes セクションの後（`// ===== ローカルポートプロキシ` の前）に以下を追加:

```typescript
  // ===== noVNC Browser Proxy Routes =====

  app.use("/browser/:browserId", (req, res) => {
    const { browserId } = req.params;
    const session = browserManager.getSession(browserId);

    if (!session) {
      res.status(404).json({ error: "Browser session not found" });
      return;
    }

    // http-proxyインスタンスはttydProxyを共用する（同一の設定で動作するため、専用インスタンスは不要）
    // websockifyは--webオプションでnoVNC静的ファイルを配信する。
    // Expressのapp.useはマウントパスを削除するため、
    // req.urlは/vnc.htmlのようになる。websockifyにはそのまま転送。
    const subPath = req.url || "/";
    req.url = subPath;

    ttydProxy.web(req, res, {
      target: `http://127.0.0.1:${session.wsPort}`,
    });
  });
```

- [ ] **Step 3: WebSocket upgradeハンドラーに `/browser/:browserId` を追加**

`server.on("upgrade", ...)` ハンドラー内の `// Handle proxy WebSocket connections` の前に以下を追加:

```typescript
    // Handle noVNC browser WebSocket connections
    const browserMatch = pathname.match(/^\/browser\/([^/]+)(\/.*)?$/);
    if (browserMatch) {
      const browserId = browserMatch[1];
      const session = browserManager.getSession(browserId);

      if (session) {
        const targetPath = browserMatch[2] || "/";
        req.url = targetPath;
        ttydProxy.ws(req, socket, head, {
          target: `ws://127.0.0.1:${session.wsPort}`,
        });
        return;
      }
      socket.destroy();
      return;
    }
```

- [ ] **Step 4: ローカルポートプロキシのSSRF対策にVNC/WSポート範囲を追加**

`app.all("/proxy/:port/*", ...)` ハンドラー内の ttydポート範囲チェックの後に追加:

```typescript
    // VNC/WebSocketポート範囲もブロック（noVNCブラウザセッション用）
    if (
      (port >= VNC_PORT_START && port <= VNC_PORT_END) ||
      (port >= WS_PORT_START && port <= WS_PORT_END)
    ) {
      res.status(403).json({ error: "This port is not accessible via proxy" });
      return;
    }
```

WebSocket upgradeハンドラー内の proxy SSRF チェックも同様に更新:

```typescript
        if (
          proxyPort === serverPort ||
          (proxyPort >= TTYD_PORT_START && proxyPort <= TTYD_PORT_END) ||
          (proxyPort >= VNC_PORT_START && proxyPort <= VNC_PORT_END) ||
          (proxyPort >= WS_PORT_START && proxyPort <= WS_PORT_END)
        ) {
          socket.destroy();
          return;
        }
```

- [ ] **Step 5: 本番用静的ファイルルーティングに `/browser/` を除外パターン追加**

```typescript
    app.get(/^(?!\/ttyd\/|\/proxy\/|\/browser\/).*$/, (_req, res) => {
      res.sendFile(path.join(staticPath, "index.html"));
    });
```

- [ ] **Step 6: Socket.IOハンドラーにbrowser:*イベントを追加**

`io.on("connection", ...)` 内の適切な位置に以下を追加:

```typescript
    // ===== Browser Session Handlers (noVNC) =====

    // per-socket session tracking（切断時のクリーンアップ用）
    const socketBrowserSessions = new Set<string>();

    socket.on("browser:start", async (data) => {
      try {
        if (!browserManager.isAvailable()) {
          socket.emit("browser:error", {
            message: "ブラウザタブ機能は無効です。依存パッケージをインストールしてください。",
          });
          return;
        }

        // ポート範囲チェック（1-65535）
        if (data.port < 1 || data.port > 65535) {
          socket.emit("browser:error", {
            message: "ポート番号は1-65535の範囲で指定してください",
          });
          return;
        }

        // ブロックリスト（Arkサーバーポート、ttyd範囲、VNC範囲、WS範囲）
        const serverPort = Number(process.env.PORT) || 3001;
        if (
          data.port === serverPort ||
          (data.port >= TTYD_PORT_START && data.port <= TTYD_PORT_END) ||
          (data.port >= VNC_PORT_START && data.port <= VNC_PORT_END) ||
          (data.port >= WS_PORT_START && data.port <= WS_PORT_END)
        ) {
          socket.emit("browser:error", {
            message: "このポートはブラウザタブでの表示が許可されていません",
          });
          return;
        }

        // per-socket上限チェック（3）
        const MAX_PER_SOCKET = 3;
        if (socketBrowserSessions.size >= MAX_PER_SOCKET) {
          socket.emit("browser:error", {
            message: `1接続あたりのブラウザセッション上限(${MAX_PER_SOCKET})に達しています`,
          });
          return;
        }

        const session = await browserManager.start(
          data.port,
          data.url,
          data.devtools ?? false
        );
        socketBrowserSessions.add(session.id);
        socket.emit("browser:started", session);
      } catch (e) {
        socket.emit("browser:error", {
          message: getErrorMessage(e),
        });
      }
    });

    socket.on("browser:stop", (data) => {
      browserManager.stop(data.browserId);
      socketBrowserSessions.delete(data.browserId);
      socket.emit("browser:stopped", { browserId: data.browserId });
    });

    // Socket切断時に全ブラウザセッションをクリーンアップ
    socket.on("disconnect", () => {
      for (const browserId of socketBrowserSessions) {
        browserManager.stop(browserId);
      }
      socketBrowserSessions.clear();
    });
```

- [ ] **Step 7: クリーンアップにbrowserManagerを追加**

SIGTERMハンドラー内に `browserManager.cleanup()` を追加。

- [ ] **Step 8: ポートスキャンのVNC/WSポート除外**

`server/lib/port-scanner.ts` のimportを更新:

```typescript
import {
  TTYD_PORT_END,
  TTYD_PORT_START,
  VNC_PORT_END,
  VNC_PORT_START,
  WS_PORT_END,
  WS_PORT_START,
} from "./constants.js";
```

`collectPorts` 関数内のフィルタリングに追加:

```typescript
    if (port >= TTYD_PORT_START && port <= TTYD_PORT_END) continue;
    if (port >= VNC_PORT_START && port <= VNC_PORT_END) continue;
    if (port >= WS_PORT_START && port <= WS_PORT_END) continue;
```

- [ ] **Step 9: 型チェック実行**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm check`
Expected: 型エラーなし

- [ ] **Step 10: コミット**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager
git add server/index.ts server/lib/port-scanner.ts
git commit -m "feat: noVNCブラウザのプロキシルートとSocket.IOハンドラーを追加"
```

---

### Task 5: クライアント側 useSocket.ts にブラウザイベントを追加

**Files:**
- Modify: `client/src/hooks/useSocket.ts`

- [ ] **Step 1: BrowserSession型のimportを追加**

```typescript
import type { BrowserSession } from "../../../shared/types.js";
```

- [ ] **Step 2: ブラウザセッション用のstateを追加**

既存のstate定義エリアに追加:

```typescript
const [browserSessions, setBrowserSessions] = useState<Map<string, BrowserSession>>(new Map());
const [browserError, setBrowserError] = useState<string | null>(null);
```

- [ ] **Step 3: Socket.IOイベントリスナーを追加**

`useEffect` 内のイベントリスナー登録エリアに追加:

```typescript
    socket.on("browser:started", (session: BrowserSession) => {
      setBrowserSessions(prev => {
        const next = new Map(prev);
        next.set(session.id, session);
        return next;
      });
      setBrowserError(null);
    });

    socket.on("browser:stopped", ({ browserId }: { browserId: string }) => {
      setBrowserSessions(prev => {
        const next = new Map(prev);
        next.delete(browserId);
        return next;
      });
    });

    socket.on("browser:error", ({ message }: { message: string }) => {
      setBrowserError(message);
    });
```

クリーンアップに追加:

```typescript
      socket.off("browser:started");
      socket.off("browser:stopped");
      socket.off("browser:error");
```

- [ ] **Step 4: アクション関数を追加**

```typescript
  const startBrowser = useCallback(
    (port: number, url?: string, devtools?: boolean) => {
      socketRef.current?.emit("browser:start", { port, url, devtools });
    },
    []
  );

  const stopBrowser = useCallback((browserId: string) => {
    socketRef.current?.emit("browser:stop", { browserId });
  }, []);
```

- [ ] **Step 5: return文に追加**

```typescript
    browserSessions,
    browserError,
    startBrowser,
    stopBrowser,
```

- [ ] **Step 6: 型チェック実行**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm check`
Expected: 型エラーなし

- [ ] **Step 7: コミット**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager
git add client/src/hooks/useSocket.ts
git commit -m "feat: useSocketにブラウザセッションイベントを追加"
```

---

### Task 6: BrowserPane.tsx のローカル/リモート切り替え

**Files:**
- Modify: `client/src/components/BrowserPane.tsx`

- [ ] **Step 1: BrowserPaneコンポーネントを書き換え**

`client/src/components/BrowserPane.tsx` を以下に書き換える:

```typescript
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Loader2,
  Monitor,
  RotateCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserSession } from "../../../shared/types.js";
import { Button } from "./ui/button";

interface BrowserPaneProps {
  url: string;
  port: number;
  socket: {
    emit: (event: string, data: unknown) => void;
    on: (event: string, handler: (...args: unknown[]) => void) => void;
    off: (event: string, handler: (...args: unknown[]) => void) => void;
  } | null;
}

function isLocalAccess(): boolean {
  const hostname = window.location.hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function resolveUrl(url: string): string {
  if (isLocalAccess()) return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      const defaultPort = parsed.protocol === "https:" ? "443" : "80";
      return `/proxy/${parsed.port || defaultPort}${parsed.pathname}${parsed.search}`;
    }
  } catch {
    // パース失敗時はそのまま返す
  }
  return url;
}

function getUrlToken(): string | null {
  return new URLSearchParams(window.location.search).get("token");
}

export function BrowserPane({ url, port, socket }: BrowserPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [browserSession, setBrowserSession] = useState<BrowserSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isRemote = !isLocalAccess();

  useEffect(() => {
    if (!isRemote || !socket) return;

    setLoading(true);
    setError(null);

    const handleStarted = (session: BrowserSession) => {
      setBrowserSession(session);
      setLoading(false);
    };

    const handleError = ({ message }: { message: string }) => {
      setError(message);
      setLoading(false);
    };

    socket.on("browser:started", handleStarted as (...args: unknown[]) => void);
    socket.on("browser:error", handleError as (...args: unknown[]) => void);
    socket.emit("browser:start", { port });

    return () => {
      socket.off("browser:started", handleStarted as (...args: unknown[]) => void);
      socket.off("browser:error", handleError as (...args: unknown[]) => void);
      if (browserSession) {
        socket.emit("browser:stop", { browserId: browserSession.id });
      }
    };
  }, [isRemote, socket, port]);

  const handleReload = useCallback(() => setIframeKey(k => k + 1), []);
  const handleOpenExternal = useCallback(() => window.open(url, "_blank"), [url]);

  const vncIframeSrc = browserSession
    ? (() => {
        const token = getUrlToken();
        const base = `/browser/${browserSession.id}/vnc.html?autoconnect=true&resize=scale`;
        return token ? `${base}&token=${token}` : base;
      })()
    : null;

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border shrink-0">
        <Button variant="ghost" size="icon" className="h-6 w-6"
          onClick={() => { try { iframeRef.current?.contentWindow?.history.back(); } catch {} }}
          disabled={isRemote}
          title="戻る">
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6"
          onClick={() => { try { iframeRef.current?.contentWindow?.history.forward(); } catch {} }}
          disabled={isRemote}
          title="進む">
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6"
          onClick={handleReload} title="リロード">
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
        <div className="flex-1 bg-muted rounded px-2 py-0.5 text-xs text-muted-foreground truncate mx-1 flex items-center gap-1">
          {isRemote && <Monitor className="h-3 w-3 shrink-0" />}
          {url}
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6"
          onClick={handleOpenExternal} title="外部ブラウザで開く">
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex-1 min-h-0">
        {isRemote ? (
          loading ? (
            <div className="h-full flex items-center justify-center text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin mr-2" />
              ブラウザセッションを起動中...
            </div>
          ) : error ? (
            <div className="h-full flex items-center justify-center text-destructive p-4 text-center">
              <div>
                <p className="font-medium">ブラウザタブエラー</p>
                <p className="text-sm mt-1">{error}</p>
              </div>
            </div>
          ) : vncIframeSrc ? (
            <iframe key={iframeKey} ref={iframeRef} src={vncIframeSrc}
              className="w-full h-full border-0"
              title={`Browser (noVNC) - ${url}`} />
          ) : null
        ) : (
          <iframe key={iframeKey} ref={iframeRef} src={resolveUrl(url)}
            className="w-full h-full border-0"
            title={`Browser - ${url}`} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: BrowserPaneの呼び出し元を更新**

`grep -r "BrowserPane" client/src/` で呼び出し元を特定し、新しい `port` と `socket` propsを追加する。

URLからポート番号を抽出するヘルパーを呼び出し元に追加:

```typescript
function extractPort(url: string): number {
  try {
    const parsed = new URL(url);
    return parseInt(parsed.port || (parsed.protocol === "https:" ? "443" : "80"), 10);
  } catch {
    return 80;
  }
}
```

呼び出し例: `<BrowserPane url={url} port={extractPort(url)} socket={socket} />`

- [ ] **Step 3: 型チェック実行**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm check`
Expected: 型エラーなし

- [ ] **Step 4: ビルド確認**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm build`
Expected: ビルド成功

- [ ] **Step 5: コミット**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager
git add client/src/components/BrowserPane.tsx
# 呼び出し元のファイルも変更していたらgit addする
git commit -m "feat: BrowserPaneにリモートアクセス時のnoVNC切り替えを実装"
```

---

### Task 7: セットアップスクリプトとドキュメント更新

**Files:**
- Create: `scripts/setup-browser.sh`
- Modify: `CLAUDE.md`

- [ ] **Step 1: セットアップスクリプトを作成**

`scripts/setup-browser.sh` を以下の内容で作成:

```bash
#!/bin/bash
# scripts/setup-browser.sh
# リモートアクセス時のブラウザタブ機能に必要な依存パッケージをインストール

set -e

echo "=== Ark ブラウザタブ機能セットアップ ==="
echo ""

if [ -f /etc/debian_version ]; then
  echo "[1/3] システムパッケージをインストール中..."
  sudo apt update
  sudo apt install -y xvfb x11vnc novnc chromium-browser

  echo "[2/3] websockifyをインストール中..."
  if ! command -v websockify &> /dev/null; then
    sudo apt install -y python3-websockify || pip3 install websockify
  fi

  echo "[3/3] インストール確認..."
  for cmd in Xvfb x11vnc websockify; do
    if command -v "$cmd" &> /dev/null; then
      echo "  OK: $cmd"
    else
      echo "  NG: $cmd (インストール失敗)"
    fi
  done

  if command -v chromium-browser &> /dev/null || command -v chromium &> /dev/null; then
    echo "  OK: chromium"
  else
    echo "  NG: chromium (インストール失敗)"
  fi

  echo ""
  echo "セットアップ完了。Arkサーバーを再起動してください。"
else
  echo "このスクリプトはDebian/Ubuntu向けです。"
  echo "以下のパッケージを手動でインストールしてください："
  echo "  - Xvfb"
  echo "  - x11vnc"
  echo "  - websockify"
  echo "  - chromium-browser"
  echo "  - novnc"
  exit 1
fi
```

- [ ] **Step 2: 実行権限を付与**

Run: `chmod +x scripts/setup-browser.sh`

- [ ] **Step 3: CLAUDE.mdの前提条件セクションを更新**

`CLAUDE.md` の「前提条件」セクションに以下を追加:

```markdown
- **Xvfb, x11vnc, websockify, Chromium, novnc**（ブラウザタブのリモート表示機能使用時のみ。`scripts/setup-browser.sh` でインストール可）
```

- [ ] **Step 4: コミット**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager
git add scripts/setup-browser.sh CLAUDE.md
git commit -m "feat: ブラウザタブ機能のセットアップスクリプトとドキュメント更新"
```

---

### Task 8: 統合テストと動作確認

- [ ] **Step 1: 依存パッケージのインストール確認**

Run: `bash scripts/setup-browser.sh`
Expected: 全パッケージがインストールされること

- [ ] **Step 2: 型チェック**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm check`
Expected: 型エラーなし

- [ ] **Step 3: ビルド**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm build`
Expected: ビルド成功

- [ ] **Step 4: サーバー起動テスト**

起動ログで `[BrowserManager]` の警告が出ないことを確認。

- [ ] **Step 5: ローカルアクセスで既存機能の回帰テスト**

localhostでアクセスし、ブラウザタブが従来通りiframe直接表示で動作すること。

- [ ] **Step 6: リモートアクセスでnoVNC動作確認**

Quick Tunnel経由でアクセスし、ブラウザタブを開いてnoVNC画面が表示されること。

- [ ] **Step 7: ポートスキャンにVNC/WSポートが除外されていることを確認**

ポートスキャン結果に5900-5999, 6080-6179のポートが含まれないこと。

- [ ] **Step 8: SSRF対策テスト**

`/proxy/5900/` や `/proxy/6080/` にアクセスし、403が返ること。

- [ ] **Step 9: セッション停止後のプロセスクリーンアップ確認**

ブラウザセッション停止後、Xvfb/x11vnc/websockify/chromiumプロセスが残っていないこと:

Run: `ps aux | grep -E "Xvfb|x11vnc|websockify|chromium" | grep -v grep`
Expected: 対象プロセスなし
