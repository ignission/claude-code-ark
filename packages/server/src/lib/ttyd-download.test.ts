import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadTtyd, ttydAssetFor } from "./ttyd-download.js";

const BODY = Buffer.from("fake ttyd binary");
const SHA256 = createHash("sha256").update(BODY).digest("hex");

function fetchReturning(body: Buffer, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as typeof fetch;
}

describe("ttydAssetFor", () => {
  it("Linux の x64 と arm64 には公式バイナリを返す", () => {
    expect(ttydAssetFor("linux", "x64")?.url).toMatch(/ttyd\.x86_64$/);
    expect(ttydAssetFor("linux", "arm64")?.url).toMatch(/ttyd\.aarch64$/);
  });

  it("公式バイナリが無い機械には null を返す", () => {
    expect(ttydAssetFor("darwin", "arm64")).toBeNull();
    expect(ttydAssetFor("linux", "riscv64")).toBeNull();
  });
});

describe("downloadTtyd", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ark-ttyd-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sha256 が合えば実行できる形で置く", async () => {
    const destDir = path.join(dir, "bin");
    const dest = await downloadTtyd(
      destDir,
      { url: "https://example.invalid/ttyd", sha256: SHA256 },
      fetchReturning(BODY)
    );

    expect(dest).toBe(path.join(destDir, "ttyd"));
    expect(await readFile(dest)).toEqual(BODY);
    expect((await stat(dest)).mode & 0o111).not.toBe(0);
  });

  it("sha256 が合わなければ何も置かない", async () => {
    await expect(
      downloadTtyd(
        dir,
        { url: "https://example.invalid/ttyd", sha256: "0".repeat(64) },
        fetchReturning(BODY)
      )
    ).rejects.toThrow(/sha256 mismatch/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("応答が止まっても待ち続けないよう、時間切れを付けて取得する", async () => {
    let signal: AbortSignal | null | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      signal = init?.signal;
      return new Response(BODY);
    }) as typeof fetch;

    await downloadTtyd(
      dir,
      { url: "https://example.invalid/ttyd", sha256: SHA256 },
      fetchImpl
    );
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("取得に失敗したら HTTP の状態を伝える", async () => {
    await expect(
      downloadTtyd(
        dir,
        { url: "https://example.invalid/ttyd", sha256: SHA256 },
        fetchReturning(Buffer.from("not found"), 404)
      )
    ).rejects.toThrow(/HTTP 404/);
    expect(await readdir(dir)).toEqual([]);
  });
});
