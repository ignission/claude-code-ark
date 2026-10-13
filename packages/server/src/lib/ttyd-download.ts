/**
 * ttyd の公式の静的バイナリを取得する。
 *
 * npm パッケージから起動した Linux で、ttyd が見つからないときに `preflight.ts` が呼ぶ。
 * ttyd はディストリのパッケージに無いことが多く、利用者に探させると最初の起動で止まる。
 * 公式のリリースは静的リンクなので、落として置くだけで動く。
 *
 * 取得するのは下の一覧に固定した版だけで、sha256 が合わなければ置かない。
 * 版を上げるときは、リリースの `SHA256SUMS` と照らして一覧を書き換える。
 * macOS 向けの公式バイナリは無いので、対象は Linux の x64 と arm64 だけ。
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface TtydAsset {
  url: string;
  sha256: string;
}

const TTYD_VERSION = "1.7.7";
const TTYD_RELEASE_BASE = `https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}`;

const TTYD_ASSETS: Record<string, TtydAsset> = {
  x64: {
    url: `${TTYD_RELEASE_BASE}/ttyd.x86_64`,
    sha256: "8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55",
  },
  arm64: {
    url: `${TTYD_RELEASE_BASE}/ttyd.aarch64`,
    sha256: "b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165",
  },
};

/** この機械に合う公式バイナリ。無ければ null (利用者が自分で入れる) */
export function ttydAssetFor(platform: string, arch: string): TtydAsset | null {
  if (platform !== "linux") return null;
  return TTYD_ASSETS[arch] ?? null;
}

/**
 * asset を取得し、sha256 を確かめてから `<destDir>/ttyd` に置く。置いたパスを返す。
 * 途中で失敗しても壊れた `ttyd` を残さないよう、一時ファイルへ書いてから rename する。
 */
export async function downloadTtyd(
  destDir: string,
  asset: TtydAsset,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const response = await fetchImpl(asset.url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${asset.url}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual !== asset.sha256) {
    throw new Error(
      `sha256 mismatch for ${asset.url}: expected ${asset.sha256}, got ${actual}`
    );
  }

  await mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, "ttyd");
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, body);
    await chmod(tmp, 0o755);
    await rename(tmp, dest);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  return dest;
}
