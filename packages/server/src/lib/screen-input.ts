/**
 * リモート画面の入力値検証。
 *
 * 値はそのまま `ssh` の引数になるので、ホスト名とユーザー名は
 * `-` 始まり (オプションに化ける) と空白・記号を拒否する。
 */

import type { ScreenInput, ScreenPatch } from "@ark/shared";
import { getErrorMessage } from "./errors.js";

export type ScreenValidation<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; code: string };

/** ホスト名 / IPv4。先頭の `-` は不可 */
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
/** POSIX ユーザー名。先頭の `-` は不可 */
const USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

type Field = keyof ScreenInput;

function fail(message: string, code: string): ScreenValidation<never> {
  return { ok: false, message, code };
}

function parsePort(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 65535) {
    return null;
  }
  return n;
}

function validateField(
  field: Field,
  value: unknown
): ScreenValidation<string | number> {
  switch (field) {
    case "name": {
      const name = typeof value === "string" ? value.trim() : "";
      return name
        ? { ok: true, value: name }
        : fail("名前を入力してください", "invalid_name");
    }
    case "sshHost":
    case "vncHost": {
      const host = typeof value === "string" ? value.trim() : "";
      return HOST_PATTERN.test(host)
        ? { ok: true, value: host }
        : fail(
            `${field === "sshHost" ? "SSH" : "VNC"} ホストはホスト名か IP アドレスで指定してください`,
            "invalid_host"
          );
    }
    case "sshUser": {
      const user = typeof value === "string" ? value.trim() : "";
      return USER_PATTERN.test(user)
        ? { ok: true, value: user }
        : fail("SSH ユーザー名が不正です", "invalid_user");
    }
    case "vncUser": {
      const user = typeof value === "string" ? value.trim() : "";
      return { ok: true, value: user };
    }
    case "sshPort":
    case "vncPort": {
      const port = parsePort(value);
      return port !== null
        ? { ok: true, value: port }
        : fail(
            `${field === "sshPort" ? "SSH" : "VNC"} ポートは 1〜65535 の整数で指定してください`,
            "invalid_port"
          );
    }
    case "vncPassword": {
      return typeof value === "string" && value.length > 0
        ? { ok: true, value }
        : fail("VNC パスワードを入力してください", "invalid_password");
    }
  }
}

const DEFAULTS: Pick<ScreenInput, "vncHost" | "vncPort" | "vncUser"> = {
  vncHost: "127.0.0.1",
  vncPort: 5900,
  vncUser: "",
};

const FIELDS: Field[] = [
  "name",
  "sshHost",
  "sshPort",
  "sshUser",
  "vncHost",
  "vncPort",
  "vncUser",
  "vncPassword",
];

/** 作成入力。vncHost / vncPort / vncUser は省略時に既定値で補う */
export function validateScreenInput(
  raw: unknown
): ScreenValidation<ScreenInput> {
  if (typeof raw !== "object" || raw === null) {
    return fail("入力が不正です", "invalid_input");
  }
  const source: Record<string, unknown> = {
    ...DEFAULTS,
    ...(raw as Record<string, unknown>),
  };
  const value: Record<string, string | number> = {};
  for (const field of FIELDS) {
    const result = validateField(field, source[field]);
    if (!result.ok) return result;
    value[field] = result.value;
  }
  return { ok: true, value: value as unknown as ScreenInput };
}

/** `screens.name` の UNIQUE 制約違反。better-sqlite3 の SqliteError の message */
const DUPLICATE_NAME_PATTERN = /UNIQUE constraint failed: screens\.name/;

/**
 * DB 由来の例外を `screen:error` の payload にする。
 *
 * 名前の重複だけは利用者の打ち手 (別の名前を付ける) がはっきりしているので、
 * SQLite の英語メッセージをそのまま出さずに日本語へ訳す。
 * 判定に使うのは message だけで、`code` (`SQLITE_CONSTRAINT_UNIQUE`) は見ない。
 * code は「どこかの UNIQUE に触れた」しか言わないので、将来 `screens` の別の列に
 * UNIQUE を足したときに名前の重複と区別できるのは message だけだから。
 * `SqliteError` は better-sqlite3 の named export ではない
 * (`Database.SqliteError`) ので、クラスではなく形で見る。
 */
export function describeScreenDbError(e: unknown): {
  message: string;
  code?: string;
} {
  if (e instanceof Error && DUPLICATE_NAME_PATTERN.test(e.message)) {
    return {
      message: "同じ名前の画面が既に登録されています",
      code: "duplicate_name",
    };
  }
  return { message: getErrorMessage(e) };
}

/** 部分更新。undefined と空の vncPassword は「変更しない」 */
export function validateScreenPatch(
  raw: unknown
): ScreenValidation<ScreenPatch> {
  if (typeof raw !== "object" || raw === null) {
    return fail("入力が不正です", "invalid_input");
  }
  const source = raw as Record<string, unknown>;
  const value: Record<string, string | number> = {};
  for (const field of FIELDS) {
    const input = source[field];
    if (input === undefined) continue;
    if (field === "vncPassword" && input === "") continue;
    const result = validateField(field, input);
    if (!result.ok) return result;
    value[field] = result.value;
  }
  return { ok: true, value: value as ScreenPatch };
}
