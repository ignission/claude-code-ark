import { describe, expect, it } from "vitest";
import { isLeaderKey, KEYNAV_HELP, resolveKey } from "./keynav";

describe("isLeaderKey", () => {
  it("Ctrl+; だけを前置キーにする", () => {
    expect(isLeaderKey({ key: ";", ctrlKey: true })).toBe(true);
    // 配列によって key が変わっても、物理キーで拾う
    expect(isLeaderKey({ key: "+", code: "Semicolon", ctrlKey: true })).toBe(
      true
    );
    expect(isLeaderKey({ key: ";" })).toBe(false);
    expect(isLeaderKey({ key: ";", ctrlKey: true, metaKey: true })).toBe(false);
    expect(isLeaderKey({ key: ";", ctrlKey: true, altKey: true })).toBe(false);
  });
});

describe("resolveKey", () => {
  it("1 文字のキーを指示に直す", () => {
    expect(resolveKey("", { key: "j" })).toEqual({
      command: { type: "move", dir: 1 },
      pending: "",
      handled: true,
    });
    expect(resolveKey("", { key: "K" }).command).toEqual({
      type: "session",
      dir: -1,
    });
    expect(resolveKey("", { key: "i" }).command).toEqual({ type: "insert" });
    expect(resolveKey("", { key: "?" }).command).toEqual({ type: "help" });
  });

  it("g は次のキーを待ち、2 打で指示になる", () => {
    const first = resolveKey("", { key: "g" });
    expect(first).toEqual({ pending: "g", handled: true });

    expect(resolveKey("g", { key: "g" }).command).toEqual({
      type: "edge",
      to: "start",
    });
    expect(resolveKey("g", { key: "s" }).command).toEqual({
      type: "work-tab",
      tab: "git",
    });
    expect(resolveKey("g", { key: "T" }).command).toEqual({
      type: "file-tab",
      dir: -1,
    });
    // 割り当ての無い 2 打目は、打ちかけを消すだけ
    expect(resolveKey("g", { key: "x" })).toEqual({
      command: undefined,
      pending: "",
      handled: true,
    });
  });

  it("gT の Shift を押した時点では、打ちかけを消さない", () => {
    expect(resolveKey("g", { key: "Shift" })).toEqual({
      pending: "g",
      handled: false,
    });
  });

  it("割り当ての無い文字も受け取る (入力もページ内検索もさせない)", () => {
    expect(resolveKey("", { key: "z" })).toEqual({
      command: undefined,
      pending: "",
      handled: true,
    });
    expect(resolveKey("", { key: "/" }).handled).toBe(true);
  });

  it("Enter・Tab・矢印はブラウザに任せる (フォーカスのある行が自分で動く)", () => {
    for (const key of ["Enter", "Tab", "ArrowDown", "F5"]) {
      expect(resolveKey("", { key })).toEqual({ pending: "", handled: false });
    }
  });

  it("修飾キーつきは Ctrl+d / Ctrl+u だけ受け取り、ほかはブラウザに任せる", () => {
    expect(resolveKey("", { key: "d", ctrlKey: true }).command).toEqual({
      type: "page",
      dir: 1,
    });
    expect(resolveKey("", { key: "u", ctrlKey: true }).command).toEqual({
      type: "page",
      dir: -1,
    });
    expect(resolveKey("", { key: "r", ctrlKey: true }).handled).toBe(false);
    expect(resolveKey("", { key: "j", metaKey: true }).handled).toBe(false);
    expect(resolveKey("", { key: "j", altKey: true }).handled).toBe(false);
  });

  it("Esc は打ちかけを取り消す", () => {
    expect(resolveKey("g", { key: "Escape" })).toEqual({
      command: { type: "cancel" },
      pending: "",
      handled: true,
    });
  });

  it("一覧に出すキーは、どれも実際に指示になる", () => {
    const keys = KEYNAV_HELP.flatMap(group => group.rows.map(row => row[0]))
      .flatMap(label => label.split(" / "))
      .filter(key => /^[a-zA-Z?]{1,2}$/.test(key));
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) {
      const [first, second] = key;
      const result = second
        ? resolveKey(resolveKey("", { key: first }).pending, { key: second })
        : resolveKey("", { key: first });
      expect(result.command, key).toBeDefined();
    }
  });
});
