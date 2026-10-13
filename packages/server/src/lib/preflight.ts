/**
 * npm パッケージから起動したときの前提の検査 (`bin.ts` が起動の最初に呼ぶ)。
 *
 * 欠けている道具は、サーバーを立てる前にまとめて1回で伝える。検査が無いと、
 * 画面は出るのにセッションを作った時点で分かりにくく失敗する。
 * ttyd だけは、公式バイナリがある機械なら自分で取得して先へ進む (`ttyd-download.ts`)。
 *
 * サーバー本体 (express や better-sqlite3) を読み込む前に動くので、
 * ここから import してよいのは Node の組み込みと、組み込みだけに依存するモジュール。
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { type TtydAsset, ttydAssetFor } from "./ttyd-download.js";

/** 同梱の Claude Code と Vite 8 の要件 (package.json の engines と揃える) */
const MIN_NODE = { major: 22, minor: 12 };

/** Node が要件を満たさなければ、伝える文を返す。満たせば null */
export function nodeVersionProblem(version: string): string | null {
  const [major, minor] = version.split(".").map(Number);
  if (
    major > MIN_NODE.major ||
    (major === MIN_NODE.major && minor >= MIN_NODE.minor)
  ) {
    return null;
  }
  return `Ark requires Node.js >= ${MIN_NODE.major}.${MIN_NODE.minor} but got ${version}.`;
}

/**
 * npm パッケージから起動したときのデータの置き場。
 * リポジトリから起動するときの `<cwd>/data` (`paths.ts`) をそのまま使うと、
 * npx を打ったディレクトリごとに `data/` ができる。
 */
export function defaultDataDir(env: NodeJS.ProcessEnv, home: string): string {
  const base = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(base, "claude-code-ark");
}

/** PATH から実行ファイルを探す。無ければ null */
export function findOnPath(
  name: string,
  envPath: string | undefined
): string | null {
  for (const dir of (envPath ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const LINUX_INSTALLERS: Array<{ command: string; install: string }> = [
  { command: "apt-get", install: "apt-get install -y" },
  { command: "dnf", install: "dnf install -y" },
  { command: "pacman", install: "pacman -S" },
  { command: "zypper", install: "zypper install -y" },
  { command: "apk", install: "apk add" },
];

const PROJECT_URLS = {
  tmux: "https://github.com/tmux/tmux/wiki/Installing",
  ttyd: "https://github.com/tsl0922/ttyd/releases",
};

/** その機械で道具を入れる1行。パッケージマネージャが分からなければ入手先の URL */
export function installHint(
  tool: "tmux" | "ttyd",
  platform: string,
  hasCommand: (name: string) => boolean
): string {
  if (platform === "darwin") return `brew install ${tool}`;
  // ttyd はディストリのパッケージに無いことが多いので、Linux では入手先を案内する
  if (platform === "linux" && tool === "tmux") {
    const installer = LINUX_INSTALLERS.find(i => hasCommand(i.command));
    // コンテナなど sudo の無い機械 (たいてい root) では、付けると案内どおりに打てない
    const sudo = hasCommand("sudo") ? "sudo " : "";
    if (installer) return `${sudo}${installer.install} tmux`;
  }
  return PROJECT_URLS[tool];
}

export interface PreflightDeps {
  platform: string;
  arch: string;
  dataDir: string;
  /** 利用者が明示した ttyd (`ARK_TTYD_PATH`)。あれば検査も取得もしない */
  ttydOverride: string | undefined;
  resolveTmux: () => string | null;
  resolveClaude: () => string | null;
  findOnPath: (name: string) => string | null;
  fileExists: (file: string) => boolean;
  downloadTtyd: (destDir: string, asset: TtydAsset) => Promise<string>;
  log: (message: string) => void;
}

export interface PreflightResult {
  /** Ark が取得した ttyd の場所。PATH のものや利用者の指定を使うときは null */
  ttydPath: string | null;
  /** 起動を止める理由。空なら起動してよい */
  problems: string[];
}

function missing(tool: string, hint: string): string {
  return `${tool} not found. Install it:\n    ${hint}`;
}

async function ensureTtyd(
  deps: PreflightDeps
): Promise<{ ttydPath: string | null; problem: string | null }> {
  if (deps.ttydOverride || deps.findOnPath("ttyd")) {
    return { ttydPath: null, problem: null };
  }
  const binDir = path.join(deps.dataDir, "bin");
  const downloaded = path.join(binDir, "ttyd");
  if (deps.fileExists(downloaded)) {
    return { ttydPath: downloaded, problem: null };
  }

  const hint = installHint("ttyd", deps.platform, name =>
    Boolean(deps.findOnPath(name))
  );
  const asset = ttydAssetFor(deps.platform, deps.arch);
  if (!asset) return { ttydPath: null, problem: missing("ttyd", hint) };

  deps.log(`ttyd not found. Downloading ${asset.url}`);
  try {
    const ttydPath = await deps.downloadTtyd(binDir, asset);
    deps.log(`Installed ttyd to ${ttydPath}`);
    return { ttydPath, problem: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ttydPath: null,
      problem: `Failed to download ttyd (${reason}). Install it yourself:\n    ${hint}`,
    };
  }
}

/** 前提を調べ、足りないものを集める。ttyd は取得できる機械なら取得する */
export async function runPreflight(
  deps: PreflightDeps
): Promise<PreflightResult> {
  const problems: string[] = [];

  if (!deps.resolveTmux()) {
    problems.push(
      missing(
        "tmux",
        installHint("tmux", deps.platform, name =>
          Boolean(deps.findOnPath(name))
        )
      )
    );
  }

  const ttyd = await ensureTtyd(deps);
  if (ttyd.problem) problems.push(ttyd.problem);

  if (!deps.resolveClaude()) {
    problems.push(
      missing("claude", "npm install -g @anthropic-ai/claude-code")
    );
  }

  return { ttydPath: ttyd.ttydPath, problems };
}
