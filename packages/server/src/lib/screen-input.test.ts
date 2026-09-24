import { describe, expect, it } from "vitest";
import {
  describeScreenDbError,
  validateScreenInput,
  validateScreenPatch,
} from "./screen-input.js";

const valid = {
  name: " ビルド VM ",
  sshHost: "build.example.internal",
  sshPort: 2222,
  sshUser: "user",
  vncHost: "127.0.0.1",
  vncPort: 5900,
  vncUser: "user",
  vncPassword: "secret",
};

describe("validateScreenInput", () => {
  it("正常値は trim して返す", () => {
    const result = validateScreenInput(valid);
    expect(result).toEqual({
      ok: true,
      value: { ...valid, name: "ビルド VM" },
    });
  });

  it("vncHost / vncPort / vncUser は既定値で補う", () => {
    const { vncHost: _h, vncPort: _p, vncUser: _u, ...rest } = valid;
    const result = validateScreenInput({ ...rest, sshPort: "22" });
    expect(result).toEqual({
      ok: true,
      value: {
        ...rest,
        name: "ビルド VM",
        sshPort: 22,
        vncHost: "127.0.0.1",
        vncPort: 5900,
        vncUser: "",
      },
    });
  });

  it.each([
    [{ name: "" }, "invalid_name"],
    [{ sshHost: "" }, "invalid_host"],
    [{ sshHost: "-oProxyCommand=x" }, "invalid_host"],
    [{ sshHost: "a b" }, "invalid_host"],
    [{ vncHost: "-x" }, "invalid_host"],
    [{ sshUser: "" }, "invalid_user"],
    [{ sshUser: "-l" }, "invalid_user"],
    [{ sshPort: 0 }, "invalid_port"],
    [{ sshPort: 70000 }, "invalid_port"],
    [{ vncPort: "abc" }, "invalid_port"],
    [{ vncPassword: "" }, "invalid_password"],
  ])("%o は %s で拒否する", (override, code) => {
    const result = validateScreenInput({ ...valid, ...override });
    expect(result).toMatchObject({ ok: false, code });
  });

  it("オブジェクト以外は拒否する", () => {
    expect(validateScreenInput(null)).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });
});

describe("validateScreenPatch", () => {
  it("指定したフィールドだけ検証して返す", () => {
    expect(validateScreenPatch({ name: " x ", vncPort: 5901 })).toEqual({
      ok: true,
      value: { name: "x", vncPort: 5901 },
    });
  });

  it("空の vncPassword は「変更しない」として落とす", () => {
    expect(validateScreenPatch({ vncPassword: "" })).toEqual({
      ok: true,
      value: {},
    });
  });

  it("不正なフィールドがあれば拒否する", () => {
    expect(validateScreenPatch({ sshHost: "-bad" })).toMatchObject({
      ok: false,
      code: "invalid_host",
    });
  });
});

describe("describeScreenDbError", () => {
  it("名前の重複は日本語にして code を付ける", () => {
    // better-sqlite3 の SqliteError が持つ message と code を模す
    const error = Object.assign(
      new Error("UNIQUE constraint failed: screens.name"),
      { code: "SQLITE_CONSTRAINT_UNIQUE" }
    );
    expect(describeScreenDbError(error)).toEqual({
      message: "同じ名前の画面が既に登録されています",
      code: "duplicate_name",
    });
  });

  it("別の列の UNIQUE 違反は重複名として扱わない", () => {
    const error = Object.assign(
      new Error("UNIQUE constraint failed: screens.id"),
      { code: "SQLITE_CONSTRAINT_UNIQUE" }
    );
    expect(describeScreenDbError(error)).toEqual({
      message: "UNIQUE constraint failed: screens.id",
    });
  });

  it("その他の例外はメッセージをそのまま返す", () => {
    expect(describeScreenDbError(new Error("database is locked"))).toEqual({
      message: "database is locked",
    });
    // Error でない値は getErrorMessage と同じく潰す
    expect(describeScreenDbError("なにか")).toEqual({
      message: "Unknown error",
    });
  });
});
