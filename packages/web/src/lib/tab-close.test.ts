import { describe, expect, it } from "vitest";
import type { ViewerTab } from "../components/TerminalPane";
import { correctActiveIndexAfterClose } from "./tab-close";

const terminal: ViewerTab = { type: "terminal", id: "terminal" };
const diagram = (id: string): ViewerTab => ({
  type: "diagram",
  id,
  worktreePath: "/wt",
  relPath: `${id}.diagram.html`,
});
const file = (id: string): ViewerTab => ({
  type: "file",
  id,
  filePath: `/${id}.txt`,
  content: "",
  mimeType: "text/plain",
  size: 0,
});

describe("correctActiveIndexAfterClose", () => {
  it("再現手順: [terminal, diagram, file] で file (active) を閉じると diagram を飛ばして terminal に着地する", () => {
    // board_open で開いた diagram タブがある状態でファイルタブを閉じるケース。
    // 素朴な current-1 補正だと diagram（タブバー非表示）に着地し、
    // TerminalPane の描画分岐がすべて外れて左ペインが空白になる回帰がある。
    const tabsAfterClose = [terminal, diagram("d1")]; // file(idx=2) を splice 済み
    const result = correctActiveIndexAfterClose(tabsAfterClose, 2, 2);
    expect(result).toBe(0);
  });

  it("diagram タブが連続していても terminal まで飛ばす", () => {
    const tabsAfterClose = [terminal, diagram("d1"), diagram("d2")]; // file(idx=3) を splice 済み
    const result = correctActiveIndexAfterClose(tabsAfterClose, 3, 3);
    expect(result).toBe(0);
  });

  it("diagram が絡まない通常ケースでは単純に1つ手前へ補正する", () => {
    const tabsAfterClose = [terminal, file("f2")]; // file(idx=1) を splice 済み
    const result = correctActiveIndexAfterClose(tabsAfterClose, 1, 1);
    expect(result).toBe(0);
  });

  it("閉じたタブが active より後ろなら active はそのまま", () => {
    const tabsAfterClose = [terminal, file("f1")]; // diagram(idx=2) を splice 済み
    const result = correctActiveIndexAfterClose(tabsAfterClose, 2, 1);
    expect(result).toBe(1);
  });

  it("active が既に 0 (terminal) なら補正しない", () => {
    const tabsAfterClose = [terminal];
    const result = correctActiveIndexAfterClose(tabsAfterClose, 1, 0);
    expect(result).toBe(0);
  });
});
