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
      const kept = entries.filter(entry => !referencesLegacyContext(entry));
      removedHooks += entries.length - kept.length;
      if (kept.length === entries.length) continue;
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
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

  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(
    `[LegacyContext] ${settingsPath}: hook ${removedHooks} 件 / deny ${removedDeny.length} 件を撤去しました`
  );
  return { changed: true, removedHooks, removedDeny };
}
