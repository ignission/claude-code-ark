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
import { m } from "./i18n.js";

/**
 * 組み込みコマンド。説明は利用者の言語で出すので、定数に持たず、呼ばれるたびに辞書を読む
 */
function builtInCommands(): SlashCommandInfo[] {
  const d = m().serverLib.slashCommands;
  return [
    { name: "/clear", description: d.clear, source: "built-in" },
    { name: "/compact", description: d.compact, source: "built-in" },
    { name: "/help", description: d.help, source: "built-in" },
    { name: "/init", description: d.init, source: "built-in" },
    { name: "/review", description: d.review, source: "built-in" },
    {
      name: "/install-github-app",
      description: d.installGithubApp,
      source: "built-in",
    },
    { name: "/login", description: d.login, source: "built-in" },
    { name: "/logout", description: d.logout, source: "built-in" },
    { name: "/config", description: d.config, source: "built-in" },
    { name: "/cost", description: d.cost, source: "built-in" },
    { name: "/model", description: d.model, source: "built-in" },
    { name: "/permissions", description: d.permissions, source: "built-in" },
    { name: "/resume", description: d.resume, source: "built-in" },
  ];
}

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
      // lstat で symlink を追従せずに判定する。コマンドディレクトリは
      // 入力境界として信用できないため、symlink 経由で許可ディレクトリ外の
      // 任意ファイル先頭 (description 行) が slash 補完へ露出するのを防ぐ
      stat = await fs.lstat(full);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
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
  for (const c of [...project, ...global, ...plugin, ...builtInCommands()]) {
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
