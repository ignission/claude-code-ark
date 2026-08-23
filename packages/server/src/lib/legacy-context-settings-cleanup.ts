import fs from "node:fs";
import path from "node:path";

/**
 * 撤去済み ark/context が worktree の `.claude/settings.local.json` へ書き込んだ
 * 設定を取り除く。
 *
 * ark/context は session-init で hook と tool deny を注入し、teardown で戻していた。
 * 機構ごと撤去したため teardown は走らず、**注入されたままの settings が repo に残る**。
 * 放置すると削除済みスクリプトを指す hook が毎回失敗し、`TodoWrite` などが
 * 永久に拒否され続ける (#367 の撤去に伴う移行)。
 *
 * 判定は「ark/context を指す hook があること」を証拠にする。証拠が無いファイルには
 * 触れない — 同じ tool を利用者が自分で deny している可能性があるため。
 */

/** ark/context が注入していた tool deny。この 3 つが一組で入る。 */
const INJECTED_DENY = ["TodoWrite", "TaskCreate", "TaskUpdate"] as const;

/** ark/context が hook を挿していた event。 */
const INJECTED_HOOK_EVENTS = [
  "PostToolBatch",
  "PostToolUseFailure",
  "SessionStart",
] as const;

const LEGACY_MARKER = "ark/context";

export interface LegacyContextCleanupResult {
  /** settings を書き換えたか。 */
  changed: boolean;
  /** 取り除いた hook entry の数。 */
  removedHooks: number;
  /** 取り除いた deny の tool 名。 */
  removedDeny: string[];
}

const NOOP: LegacyContextCleanupResult = {
  changed: false,
  removedHooks: 0,
  removedDeny: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** hook entry (= { hooks: [{ command }] }) が ark/context を指すか。 */
function referencesLegacyContext(entry: unknown): boolean {
  return JSON.stringify(entry ?? null).includes(LEGACY_MARKER);
}

/**
 * worktree の settings.local.json から ark/context 由来の設定を取り除く。
 * ファイルが無い / JSON が壊れている / 証拠が無い場合は何もしない (冪等)。
 */
export function cleanupLegacyContextSettings(
  worktreePath: string
): LegacyContextCleanupResult {
  // 空文字や相対パスを受けると、呼び出し元プロセスの cwd を掃除してしまう。
  // 掃除は「この worktree の設定を戻す」操作なので、絶対パス以外は扱わない。
  if (!worktreePath || !path.isAbsolute(worktreePath)) return NOOP;
  const settingsPath = path.join(
    worktreePath,
    ".claude",
    "settings.local.json"
  );
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf-8");
  } catch {
    return NOOP;
  }
  if (!raw.includes(LEGACY_MARKER)) return NOOP;

  let settings: unknown;
  try {
    settings = JSON.parse(raw);
  } catch {
    // 壊れた settings を推測で直さない。理由を残して素通りする。
    console.warn(
      `[LegacyContext] ${settingsPath} が JSON として読めないため掃除を見送ります`
    );
    return NOOP;
  }
  if (!isRecord(settings)) return NOOP;

  let removedHooks = 0;
  const hooks = settings.hooks;
  if (isRecord(hooks)) {
    for (const event of INJECTED_HOOK_EVENTS) {
      const entries = hooks[event];
      if (!Array.isArray(entries)) continue;
      let changed = false;
      const keptEntries: unknown[] = [];
      for (const entry of entries) {
        // legacy と利用者の command が 1 グループに同居しうる。entry 単位で落とすと
        // 利用者の hook と matcher まで消えるため、command 単位で除く。
        if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
          if (referencesLegacyContext(entry)) {
            removedHooks += 1;
            changed = true;
          } else {
            keptEntries.push(entry);
          }
          continue;
        }
        const keptCommands = entry.hooks.filter(
          hook => !referencesLegacyContext(hook)
        );
        const removedHere = entry.hooks.length - keptCommands.length;
        if (removedHere > 0) {
          removedHooks += removedHere;
          changed = true;
        }
        // command が全部消えたグループだけを落とす（matcher ごと消える）。
        if (keptCommands.length === 0) continue;
        entry.hooks = keptCommands;
        keptEntries.push(entry);
      }
      if (!changed) continue;
      if (keptEntries.length === 0) delete hooks[event];
      else hooks[event] = keptEntries;
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks;
  }

  // hook の証拠が無いなら deny は利用者のものとみなして残す。
  const removedDeny: string[] = [];
  const permissions = settings.permissions;
  if (removedHooks > 0 && isRecord(permissions)) {
    const deny = permissions.deny;
    if (Array.isArray(deny)) {
      const kept = deny.filter(
        tool => !INJECTED_DENY.includes(tool as (typeof INJECTED_DENY)[number])
      );
      for (const tool of deny) {
        if (kept.includes(tool)) continue;
        removedDeny.push(String(tool));
      }
      if (kept.length === 0) delete permissions.deny;
      else if (kept.length !== deny.length) permissions.deny = kept;
    }
    if (Object.keys(permissions).length === 0) delete settings.permissions;
  }

  if (removedHooks === 0 && removedDeny.length === 0) return NOOP;

  try {
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (error) {
    // 掃除はセッション起動の前提ではない。read-only 等で書けなくても起動は続ける。
    console.warn(
      `[LegacyContext] ${settingsPath} を書き換えられないため掃除を見送ります: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return NOOP;
  }
  console.log(
    `[LegacyContext] ${settingsPath}: hook ${removedHooks} 件 / deny ${removedDeny.length} 件を撤去しました`
  );
  return { changed: true, removedHooks, removedDeny };
}
