/**
 * Slash command 候補を以下の情報源から収集する:
 *   - 組み込みコマンド (ハードコード)
 *   - `<configDir>/commands/*.md` (グローバル / プロファイル毎)
 *   - `<worktreePath>/.claude/commands/*.md` (プロジェクト固有)
 *
 * 各 .md ファイル名 (拡張子除く) が `/<name>` になる。frontmatter の
 * `description:` があれば短い説明として添える。重複はソース優先順位で除外:
 *   project > global > plugin > built-in
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { SlashCommandInfo } from "@ark/shared";

const BUILT_IN: SlashCommandInfo[] = [
  { name: "/clear", description: "会話履歴をクリア", source: "built-in" },
  { name: "/compact", description: "履歴を要約して短縮", source: "built-in" },
  { name: "/help", description: "ヘルプを表示", source: "built-in" },
  { name: "/init", description: "CLAUDE.md を作成", source: "built-in" },
  { name: "/review", description: "PR をレビュー", source: "built-in" },
  {
    name: "/install-github-app",
    description: "GitHub App をセットアップ",
    source: "built-in",
  },
  {
    name: "/login",
    description: "Anthropic アカウントにログイン",
    source: "built-in",
  },
  { name: "/logout", description: "ログアウト", source: "built-in" },
  { name: "/config", description: "設定を表示/編集", source: "built-in" },
  {
    name: "/cost",
    description: "セッション中のコストを表示",
    source: "built-in",
  },
  { name: "/model", description: "使用モデルを切替", source: "built-in" },
  { name: "/permissions", description: "権限を確認/変更", source: "built-in" },
  {
    name: "/resume",
    description: "前回のセッションを再開",
    source: "built-in",
  },
];

const FRONTMATTER_DESC_RE = /^---[\r\n]+([\s\S]*?)^---[\r\n]+/m;
const DESCRIPTION_LINE_RE = /^description:\s*(.+?)\s*$/m;

/**
 * frontmatter 抽出に必要な分だけ読む上限。
 * `.claude/commands/*.md` は入力境界として信用できない (巨大ファイルや
 * 巨大ファイルへの symlink が置かれ得る) ため、全読みせず先頭のみ読む。
 */
const FRONTMATTER_READ_LIMIT = 4 * 1024;

async function readDescriptionFromMd(
  filePath: string
): Promise<string | undefined> {
  let fh: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    fh = await fs.open(filePath, "r");
    const buf = Buffer.alloc(FRONTMATTER_READ_LIMIT);
    const { bytesRead } = await fh.read(buf, 0, FRONTMATTER_READ_LIMIT, 0);
    const head = buf.toString("utf-8", 0, bytesRead);
    const fm = head.match(FRONTMATTER_DESC_RE);
    if (!fm) return undefined;
    const desc = fm[1].match(DESCRIPTION_LINE_RE);
    if (!desc) return undefined;
    return desc[1].replace(/^["'`]|["'`]$/g, "").trim() || undefined;
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function scanCommandsDir(
  dir: string,
  source: "global" | "project" | "plugin"
): Promise<SlashCommandInfo[]> {
  const out: SlashCommandInfo[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const stem = entry.slice(0, -3);
    if (!stem) continue;
    const full = path.join(dir, entry);
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const description = await readDescriptionFromMd(full);
    out.push({ name: `/${stem}`, description, source });
  }
  return out;
}

async function scanPluginsCommands(
  configDir: string
): Promise<SlashCommandInfo[]> {
  const pluginsRoot = path.join(configDir, "plugins");
  const out: SlashCommandInfo[] = [];
  let pluginEntries: string[];
  try {
    pluginEntries = await fs.readdir(pluginsRoot);
  } catch {
    return out;
  }
  for (const plugin of pluginEntries) {
    if (plugin.startsWith(".")) continue;
    const commandsDir = path.join(pluginsRoot, plugin, "commands");
    const cmds = await scanCommandsDir(commandsDir, "plugin");
    out.push(...cmds);
  }
  return out;
}

/**
 * 指定 worktree + configDir で利用可能な slash command 候補を集める。
 * 優先順位: project > global > plugin > built-in。同名は上位を採用。
 */
export async function listSlashCommands(
  worktreePath: string,
  configDir: string | null
): Promise<SlashCommandInfo[]> {
  const project = await scanCommandsDir(
    path.join(worktreePath, ".claude", "commands"),
    "project"
  );
  const global = configDir
    ? await scanCommandsDir(path.join(configDir, "commands"), "global")
    : [];
  const plugin = configDir ? await scanPluginsCommands(configDir) : [];

  // 優先順位順に集約。先勝ち
  const merged = new Map<string, SlashCommandInfo>();
  for (const c of [...project, ...global, ...plugin, ...BUILT_IN]) {
    if (!merged.has(c.name)) merged.set(c.name, c);
  }
  // 並び順: project → global → plugin → built-in
  return Array.from(merged.values()).sort((a, b) => {
    const rank = (s: SlashCommandInfo["source"]) =>
      s === "project" ? 0 : s === "global" ? 1 : s === "plugin" ? 2 : 3;
    const r = rank(a.source) - rank(b.source);
    if (r !== 0) return r;
    return a.name.localeCompare(b.name);
  });
}
