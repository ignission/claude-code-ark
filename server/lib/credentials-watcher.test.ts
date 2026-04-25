import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialsWatcher } from "./credentials-watcher.js";

/**
 * fake timers と実 fs を組み合わせたテスト。
 * watcher は内部で fs.statSync / readFileSync を使うため、
 * `vi.advanceTimersByTimeAsync` で確定的に時間を進められる。
 */
describe("CredentialsWatcher", () => {
  let tmpDir: string;
  let credentialsPath: string;
  let watcher: CredentialsWatcher | null = null;

  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  const writeCredentials = async (data: unknown): Promise<void> => {
    await fs.writeFile(credentialsPath, JSON.stringify(data), "utf8");
  };

  const writeRaw = async (raw: string): Promise<void> => {
    await fs.writeFile(credentialsPath, raw, "utf8");
  };

  /**
   * 同一テスト内でファイルを再書き込みする際、mtime 解像度（OSにより 1ms〜10ms）
   * の影響で stat の mtimeMs が同じになるとロジックが破綻する。
   * 必ず mtime を進めるため utimes で明示的に時刻を指定する。
   */
  const advanceFileMtime = async (fileMtimeMs: number): Promise<number> => {
    const next = fileMtimeMs + 1000;
    const sec = next / 1000;
    await fs.utimes(credentialsPath, sec, sec);
    return next;
  };

  const validPayload = {
    claudeAiOauth: {
      accessToken: "a".repeat(108),
      refreshToken: "r".repeat(108),
      expiresAt: 1234567890123,
      scopes: ["user:inference"],
      subscriptionType: "pro",
      rateLimitTier: "default",
    },
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "credentials-watcher-test-")
    );
    credentialsPath = path.join(tmpDir, ".credentials.json");
  });

  afterEach(async () => {
    if (watcher) {
      watcher.stop();
      watcher = null;
    }
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("ファイルが存在しない場合、5秒経過しても authenticated を発火しない", async () => {
    watcher = new CredentialsWatcher(credentialsPath, null, {
      stabilizationMs: 500,
      pollIntervalMs: 500,
    });
    const onAuth = vi.fn();
    watcher.on("authenticated", onAuth);

    watcher.start();

    await advance(5000);

    expect(onAuth).not.toHaveBeenCalled();
  });

  it("有効な claudeAiOauth.accessToken を持つファイルで authenticated を発火する", async () => {
    // ファイルを先に書いておく（fs.statSync が確実に成功するように）
    await writeCredentials(validPayload);

    watcher = new CredentialsWatcher(credentialsPath, null, {
      stabilizationMs: 500,
      pollIntervalMs: 500,
    });
    const onAuth = vi.fn();
    watcher.on("authenticated", onAuth);

    watcher.start();

    // ポーリング (500ms) → 安定化 (500ms) → 検出
    await advance(2000);

    expect(onAuth).toHaveBeenCalledTimes(1);
  });

  it("accessToken が空文字列の場合、authenticated を発火しない", async () => {
    await writeCredentials({
      claudeAiOauth: {
        accessToken: "",
        refreshToken: "r".repeat(108),
      },
    });

    watcher = new CredentialsWatcher(credentialsPath, null, {
      stabilizationMs: 500,
      pollIntervalMs: 500,
    });
    const onAuth = vi.fn();
    watcher.on("authenticated", onAuth);

    watcher.start();

    await advance(3000);

    expect(onAuth).not.toHaveBeenCalled();
  });

  it("不正な JSON の場合、authenticated を発火せずポーリングを続ける", async () => {
    // まず不正 JSON を書き込む
    await writeRaw("{ this is not json");

    watcher = new CredentialsWatcher(credentialsPath, null, {
      stabilizationMs: 500,
      pollIntervalMs: 500,
    });
    const onAuth = vi.fn();
    watcher.on("authenticated", onAuth);

    watcher.start();

    // ポーリングが続くが、parse 失敗で発火しない
    await advance(3000);
    expect(onAuth).not.toHaveBeenCalled();

    // 後から有効なファイルに置き換えると発火する（ポーリング継続の確認）
    // mtime を確実に進めてから書き込む
    const stat = await fs.stat(credentialsPath);
    await writeCredentials(validPayload);
    await advanceFileMtime(stat.mtimeMs);

    await advance(2000);
    expect(onAuth).toHaveBeenCalledTimes(1);
  });

  it("preLoginMtime が現在の mtime と一致する場合、authenticated を発火しない", async () => {
    // 既にファイルが存在し、有効なペイロードが書かれているケース（再ログイン用）
    await writeCredentials(validPayload);
    const stat = await fs.stat(credentialsPath);
    const preLoginMtime = stat.mtimeMs;

    watcher = new CredentialsWatcher(credentialsPath, preLoginMtime, {
      stabilizationMs: 500,
      pollIntervalMs: 500,
    });
    const onAuth = vi.fn();
    watcher.on("authenticated", onAuth);

    watcher.start();

    // mtime が preLoginMtime と一致したまま → 発火しない
    await advance(3000);

    expect(onAuth).not.toHaveBeenCalled();
  });

  it("安定化期間中に再書き込みされた場合、初回チェックは reject され、安定化後に accept される", async () => {
    watcher = new CredentialsWatcher(credentialsPath, null, {
      stabilizationMs: 500,
      pollIntervalMs: 500,
    });
    const onAuth = vi.fn();
    watcher.on("authenticated", onAuth);

    // 1回目の書き込み（中途半端なデータ）
    await writeRaw('{ "claudeAiOauth": {');
    const firstStat = await fs.stat(credentialsPath);

    watcher.start();

    // ポーリング1回目 (500ms) で stat 取得 → 安定化タイマー開始
    await advance(500);

    // 安定化期間中 (200ms 経過) に再書き込み（mtime 変わる → 初回 reject）
    await advance(200);
    await writeCredentials(validPayload);
    await advanceFileMtime(firstStat.mtimeMs);

    // 残りの安定化時間 (300ms) を進めて初回 verify を完了 → reject
    await advance(300);
    expect(onAuth).not.toHaveBeenCalled();

    // 次のポーリング以降で再検出 → 発火
    await advance(2000);
    expect(onAuth).toHaveBeenCalledTimes(1);
  });

  it("stop() 呼び出し後はファイル変更があっても発火しない", async () => {
    watcher = new CredentialsWatcher(credentialsPath, null, {
      stabilizationMs: 500,
      pollIntervalMs: 500,
    });
    const onAuth = vi.fn();
    watcher.on("authenticated", onAuth);

    watcher.start();
    watcher.stop();

    // stop 後に有効ファイルを書いても発火しない
    await writeCredentials(validPayload);

    await advance(3000);

    expect(onAuth).not.toHaveBeenCalled();
  });

  it("claudeAiOauth キー自体が存在しない場合、authenticated を発火しない", async () => {
    // claudeAiOauth が存在せず mcpOAuth だけあるケース
    await writeCredentials({
      mcpOAuth: {
        someServer: { accessToken: "x".repeat(50) },
      },
    });

    watcher = new CredentialsWatcher(credentialsPath, null, {
      stabilizationMs: 500,
      pollIntervalMs: 500,
    });
    const onAuth = vi.fn();
    watcher.on("authenticated", onAuth);

    watcher.start();

    await advance(3000);

    expect(onAuth).not.toHaveBeenCalled();
  });
});
