import { describe, expect, it } from "vitest";
import {
  DIAGRAM_NOTES_LAYER_MARKER,
  injectDiagramNotesLayer,
  NOTES_LAYER,
} from "./diagram-notes-layer.js";

const minimalDoc =
  "<!doctype html><html><head></head><body><p>本文</p></body></html>";

// 付箋の描画と操作 (ドラッグ、入力、追加、削除、図の CSS に巻き込まれないこと) は、
// レイアウトと Shadow DOM が要るので本物のブラウザで確かめる。ここでは注入と、層の決まりが
// スクリプトに残っていることだけを見る
describe("付箋の層", () => {
  it("</body> の直前へ 1 回だけ入れる", () => {
    const once = injectDiagramNotesLayer(minimalDoc);
    expect(once).toContain(`id="${DIAGRAM_NOTES_LAYER_MARKER}"`);
    expect(once.indexOf(DIAGRAM_NOTES_LAYER_MARKER)).toBeLessThan(
      once.indexOf("</body>")
    );
    expect(injectDiagramNotesLayer(once)).toBe(once);
  });

  it("本文に marker の語があるだけの板にも入れる", () => {
    const doc = minimalDoc.replace("本文", DIAGRAM_NOTES_LAYER_MARKER);
    expect(injectDiagramNotesLayer(doc)).toContain(
      `<script id="${DIAGRAM_NOTES_LAYER_MARKER}"`
    );
  });

  it("構文として正しく、Enter には何も割り当てない", () => {
    const source = NOTES_LAYER.slice(
      NOTES_LAYER.indexOf(">") + 1,
      NOTES_LAYER.lastIndexOf("</script>")
    );
    expect(() => new Function(source)).not.toThrow();
    expect(source).not.toContain("keydown");
    expect(source).not.toContain('"Enter"');
  });
});
