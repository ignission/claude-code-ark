/**
 * F6: Keychain 連携プロファイル機能 skeleton
 *
 * 既存制約 C-3 (macOS でプロファイル切替不可) の解消を目指す。
 * F0:B-3 の検証結果次第で方式 β/γ (CLAUDE_CONFIG_DIR で Keychain entry が
 * 切り替わる) または方式 α (Keychain entry が固定で keytar 退避が必要) に
 * 分岐する。
 *
 * 現状は両方式に対応できる interface ベース skeleton。本実装は F0:B-3 後。
 *
 * 関連:
 *   - `plans/macos-app-implementation-plan.md` Phase 6
 *   - `packages/server/src/lib/system.ts:detectMultiProfileSupported()`
 *   - 既存制約 C-3 (CLAUDE.md)
 */

import log from "electron-log";

/**
 * Bridge の動作モード。
 *
 * - "passthrough": CLAUDE_CONFIG_DIR の切替だけで Keychain entry も切り替わる
 *   ケース (F0:B-3 検証結果が方式 β/γ の場合)。bridge は no-op で良い。
 * - "bridge": Keychain entry が固定で keytar 経由の credentials 退避・復元が
 *   必要なケース (F0:B-3 検証結果が方式 α の場合)。
 * - "unsupported": 非対応プラットフォーム (Linux/Windows) または F0:B-3 未検証。
 */
export type KeychainProfileMode = "passthrough" | "bridge" | "unsupported";

/**
 * プロファイル切替時に Keychain との同期を行うブリッジ interface。
 *
 * server 側 (`packages/server/src/index.ts`) の profile:* ハンドラから呼ばれる
 * 想定だが、現状の skeleton では呼び出し連携は未実装 (F6-followup)。
 */
export interface KeychainProfileBridge {
  /** どの方式で動作するか */
  mode: KeychainProfileMode;

  /** プロファイル切替時の前処理 (credentials の退避等) */
  prepareSwitchTo(profileId: string): Promise<void>;

  /** プロファイル切替時の後処理 (Keychain entry 復元等) */
  afterSwitchTo(profileId: string): Promise<void>;

  /** プロファイル削除時のクリーンアップ */
  cleanupProfile(profileId: string): Promise<void>;
}

/**
 * F0:B-3 検証結果に応じて適切な実装を返す。
 *
 * 現状は skeleton のため "unsupported" を返す。
 * macOS では本来 keytar 連携の bridge 実装に置き換える。
 *
 * F6-followup:
 *   - 方式 β/γ: `createPassthroughBridge()` を返す (CLAUDE_CONFIG_DIR で済む)
 *   - 方式 α: `createKeytarBridge()` を返す (keytar で credentials 退避)
 */
export function createKeychainProfileBridge(): KeychainProfileBridge {
  if (process.platform !== "darwin") {
    return createUnsupportedBridge("Keychain bridge is macOS only");
  }

  // F0:B-3 検証結果による分岐:
  // - 方式 β/γ: createPassthroughBridge() (CLAUDE_CONFIG_DIR で済む)
  // - 方式 α: createKeytarBridge() (keytar で credentials 退避)
  //
  // 現状 skeleton: F0:B-3 未検証のため unsupported を返す。
  // F6-followup で検証結果に応じて分岐ロジックを追加。
  log.info("[keychain-bridge] F0:B-3 未検証のため unsupported モード");
  return createUnsupportedBridge("F0:B-3 verification pending");
}

/**
 * 非対応環境 (Linux/Windows) または F0:B-3 未検証時の no-op 実装。
 * すべての操作は warn ログのみ吐いて成功 (resolve) する。
 */
function createUnsupportedBridge(reason: string): KeychainProfileBridge {
  return {
    mode: "unsupported",
    async prepareSwitchTo(profileId) {
      log.warn(
        `[keychain-bridge] prepareSwitchTo(${profileId}) skipped: ${reason}`
      );
    },
    async afterSwitchTo(profileId) {
      log.warn(
        `[keychain-bridge] afterSwitchTo(${profileId}) skipped: ${reason}`
      );
    },
    async cleanupProfile(profileId) {
      log.warn(
        `[keychain-bridge] cleanupProfile(${profileId}) skipped: ${reason}`
      );
    },
  };
}

/**
 * 方式 β/γ 用 (F6-followup で実装):
 * CLAUDE_CONFIG_DIR を切り替えるだけで Keychain entry も切り替わるケース。
 * Linux 版と同じ挙動になるので bridge は no-op で良い。
 */
// function createPassthroughBridge(): KeychainProfileBridge {
//   return {
//     mode: "passthrough",
//     async prepareSwitchTo(_profileId) {
//       // no-op: CLAUDE_CONFIG_DIR が切り替われば Keychain entry も切り替わる
//     },
//     async afterSwitchTo(_profileId) {
//       // no-op
//     },
//     async cleanupProfile(_profileId) {
//       // no-op: Keychain entry は CLI 側で管理されているため、profile 削除時に
//       // 同期して消す必要はない (要 F0:B-3 検証で再確認)
//     },
//   };
// }

/**
 * 方式 α 用 (F6-followup で実装):
 * Keychain entry が固定の場合、keytar で credentials を読み書きして
 * <configDir>/.credentials.json と同期する bridge 実装。
 *
 * 想定フロー:
 *   1. prepareSwitchTo: 現在の Keychain entry を読み出して
 *      <現プロファイル configDir>/.credentials.json に書き戻す
 *   2. afterSwitchTo: <新プロファイル configDir>/.credentials.json を読んで
 *      Keychain entry に書き込む
 *   3. cleanupProfile: 該当プロファイルの credentials.json を削除
 *      (Keychain entry 本体は他プロファイルと共有のため削除しない)
 *
 * keytar の install は F6-followup で実施 (現状 skeleton では未追加)。
 */
// function createKeytarBridge(): KeychainProfileBridge {
//   // const keytar = await import("keytar");
//   // const SERVICE = "Claude Code"; // F0:B-3 で確定
//   // const ACCOUNT = "..."; // F0:B-3 で確定
//   return {
//     mode: "bridge",
//     async prepareSwitchTo(profileId) {
//       // TODO: keytar.getPassword(SERVICE, ACCOUNT) → <prev configDir>/.credentials.json
//     },
//     async afterSwitchTo(profileId) {
//       // TODO: <new configDir>/.credentials.json → keytar.setPassword(SERVICE, ACCOUNT, ...)
//     },
//     async cleanupProfile(profileId) {
//       // TODO: unlink <configDir>/.credentials.json
//     },
//   };
// }
