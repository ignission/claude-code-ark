import type { Worktree } from "@ark/shared";
import { describe, expect, it } from "vitest";
import {
  addWorktree,
  clearRepo,
  flattenWorktrees,
  pruneToRepos,
  removeWorktree,
  setRepoWorktrees,
  type WorktreesByRepo,
} from "./worktreesByRepo";

function wt(id: string, path: string): Worktree {
  return {
    id,
    path,
    branch: id,
    commit: "abc123",
    isMain: false,
    isBare: false,
  };
}

const REPO_A = "/work/a";
const REPO_B = "/work/b";

describe("worktreesByRepo", () => {
  describe("setRepoWorktrees", () => {
    it("repo ごとに worktree リストを保持し、他 repo を破壊しない", () => {
      let state: WorktreesByRepo = new Map();
      state = setRepoWorktrees(state, REPO_A, [wt("a1", "/work/a/wt1")]);
      state = setRepoWorktrees(state, REPO_B, [wt("b1", "/work/b/wt1")]);

      expect(state.get(REPO_A)).toHaveLength(1);
      expect(state.get(REPO_B)).toHaveLength(1);
      // 別 repo を上書きしない（これが「丸ごと消える」バグの修正点）
      expect(flattenWorktrees(state)).toHaveLength(2);
    });

    it("同じ repo を再受信したら丸ごと差し替える", () => {
      let state: WorktreesByRepo = new Map();
      state = setRepoWorktrees(state, REPO_A, [wt("a1", "/work/a/wt1")]);
      state = setRepoWorktrees(state, REPO_A, [
        wt("a2", "/work/a/wt2"),
        wt("a3", "/work/a/wt3"),
      ]);
      expect(state.get(REPO_A)?.map(w => w.id)).toEqual(["a2", "a3"]);
    });

    it("元の Map を変更しない（イミュータブル）", () => {
      const prev: WorktreesByRepo = new Map();
      const next = setRepoWorktrees(prev, REPO_A, [wt("a1", "/work/a/wt1")]);
      expect(prev.size).toBe(0);
      expect(next).not.toBe(prev);
    });

    it("入力配列・要素をコピーして保持する（呼び出し元の mutation が波及しない）", () => {
      const input = [wt("a1", "/work/a/wt1")];
      const state = setRepoWorktrees(new Map(), REPO_A, input);
      // 配列の後続 push は波及しない
      input.push(wt("a2", "/work/a/wt2"));
      expect(state.get(REPO_A)).toHaveLength(1);
      expect(state.get(REPO_A)).not.toBe(input);
      // 要素オブジェクトの後続 mutation も波及しない（浅いコピー）
      input[0].branch = "mutated";
      expect(state.get(REPO_A)?.[0]?.branch).toBe("a1");
    });
  });

  describe("addWorktree", () => {
    it("該当 repo に1件追加する", () => {
      let state: WorktreesByRepo = new Map();
      state = setRepoWorktrees(state, REPO_A, [wt("a1", "/work/a/wt1")]);
      state = addWorktree(state, REPO_A, wt("a2", "/work/a/wt2"));
      expect(state.get(REPO_A)?.map(w => w.id)).toEqual(["a1", "a2"]);
    });

    it("未知の repo でも bucket を新規作成する", () => {
      const state = addWorktree(new Map(), REPO_B, wt("b1", "/work/b/wt1"));
      expect(state.get(REPO_B)?.map(w => w.id)).toEqual(["b1"]);
    });

    it("重複 id は追加しない（再接続時の二重 created 対策）", () => {
      let state: WorktreesByRepo = new Map();
      state = addWorktree(state, REPO_A, wt("a1", "/work/a/wt1"));
      const before = state;
      state = addWorktree(state, REPO_A, wt("a1", "/work/a/wt1"));
      expect(state.get(REPO_A)).toHaveLength(1);
      expect(state).toBe(before); // 変化なしなら同一参照
    });
  });

  describe("removeWorktree", () => {
    it("該当 repo から id 一致を削除する", () => {
      let state: WorktreesByRepo = new Map();
      state = setRepoWorktrees(state, REPO_A, [
        wt("a1", "/work/a/wt1"),
        wt("a2", "/work/a/wt2"),
      ]);
      state = removeWorktree(state, REPO_A, "a1");
      expect(state.get(REPO_A)?.map(w => w.id)).toEqual(["a2"]);
    });

    it("存在しない id なら状態を変えない", () => {
      let state: WorktreesByRepo = new Map();
      state = setRepoWorktrees(state, REPO_A, [wt("a1", "/work/a/wt1")]);
      const before = state;
      state = removeWorktree(state, REPO_A, "zzz");
      expect(state).toBe(before);
    });

    it("未知の repo なら状態を変えない", () => {
      const before: WorktreesByRepo = new Map();
      const after = removeWorktree(before, REPO_B, "a1");
      expect(after).toBe(before);
    });
  });

  describe("clearRepo", () => {
    it("repo の bucket ごと破棄する", () => {
      let state: WorktreesByRepo = new Map();
      state = setRepoWorktrees(state, REPO_A, [wt("a1", "/work/a/wt1")]);
      state = setRepoWorktrees(state, REPO_B, [wt("b1", "/work/b/wt1")]);
      state = clearRepo(state, REPO_A);
      expect(state.has(REPO_A)).toBe(false);
      expect(state.has(REPO_B)).toBe(true);
    });

    it("未知の repo なら状態を変えない", () => {
      const before: WorktreesByRepo = new Map();
      expect(clearRepo(before, REPO_A)).toBe(before);
    });
  });

  describe("pruneToRepos", () => {
    it("repoList に無い repo の bucket を掃除する", () => {
      let state: WorktreesByRepo = new Map();
      state = setRepoWorktrees(state, REPO_A, [wt("a1", "/work/a/wt1")]);
      state = setRepoWorktrees(state, REPO_B, [wt("b1", "/work/b/wt1")]);
      state = pruneToRepos(state, [REPO_A]);
      expect(state.has(REPO_A)).toBe(true);
      expect(state.has(REPO_B)).toBe(false);
    });

    it("掃除対象が無ければ同一参照を返す", () => {
      let state: WorktreesByRepo = new Map();
      state = setRepoWorktrees(state, REPO_A, [wt("a1", "/work/a/wt1")]);
      expect(pruneToRepos(state, [REPO_A])).toBe(state);
    });
  });

  describe("flattenWorktrees", () => {
    it("全 repo の worktree を1配列に平坦化する", () => {
      let state: WorktreesByRepo = new Map();
      state = setRepoWorktrees(state, REPO_A, [
        wt("a1", "/work/a/wt1"),
        wt("a2", "/work/a/wt2"),
      ]);
      state = setRepoWorktrees(state, REPO_B, [wt("b1", "/work/b/wt1")]);
      expect(
        flattenWorktrees(state)
          .map(w => w.id)
          .sort()
      ).toEqual(["a1", "a2", "b1"]);
    });

    it("空なら空配列", () => {
      expect(flattenWorktrees(new Map())).toEqual([]);
    });

    it("repoOrder を渡すとその順で flatten する（到着順非依存）", () => {
      // 挿入順は B → A だが、repoOrder で A → B を指定する
      let state: WorktreesByRepo = new Map();
      state = setRepoWorktrees(state, REPO_B, [wt("b1", "/work/b/wt1")]);
      state = setRepoWorktrees(state, REPO_A, [
        wt("a1", "/work/a/wt1"),
        wt("a2", "/work/a/wt2"),
      ]);
      expect(flattenWorktrees(state, [REPO_A, REPO_B]).map(w => w.id)).toEqual([
        "a1",
        "a2",
        "b1",
      ]);
    });

    it("repoOrder に無い bucket は末尾に挿入順で付ける（取りこぼし防止）", () => {
      let state: WorktreesByRepo = new Map();
      state = setRepoWorktrees(state, REPO_A, [wt("a1", "/work/a/wt1")]);
      state = setRepoWorktrees(state, REPO_B, [wt("b1", "/work/b/wt1")]);
      // repoOrder に REPO_A のみ → REPO_B は末尾に残る
      expect(flattenWorktrees(state, [REPO_A]).map(w => w.id)).toEqual([
        "a1",
        "b1",
      ]);
    });
  });
});
