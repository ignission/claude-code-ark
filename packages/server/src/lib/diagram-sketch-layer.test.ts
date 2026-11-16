import { describe, expect, it } from "vitest";
import {
  DIAGRAM_SKETCH_LAYER_MARKER,
  injectDiagramSketchLayer,
  SKETCH_LAYER,
} from "./diagram-sketch-layer.js";

const source = SKETCH_LAYER.slice(
  SKETCH_LAYER.indexOf(">") + 1,
  SKETCH_LAYER.lastIndexOf("</script>")
);

describe("手書きの層", () => {
  it("構文が正しい", () => {
    expect(() => new Function(source)).not.toThrow();
  });

  it("親とやり取りするメッセージの名前を持つ", () => {
    for (const type of [
      "ark:diagram-init",
      "ark:diagram-sketch",
      "ark:diagram-sketch-error",
      "ark:diagram-sketch-labels",
      "ark:diagram-sketch-result",
      "ark:diagram-sketch-strokes",
      "ark:diagram-sketch-restore",
    ]) {
      expect(source).toContain(`"${type}"`);
    }
  });

  it("画像にする写しから、スクリプトと自分の部品と CSP を外す", () => {
    expect(source).toContain('"script,ark-sketch,meta[http-equiv]"');
  });

  it("写しは今の図の幅で組み、はみ出した分も描く", () => {
    expect(source).toContain("page.clientWidth");
    expect(source).toContain('style="overflow:visible"');
  });

  it("消しゴムと、1手ずつ戻す履歴を持つ", () => {
    expect(source).toContain('"eraser","undo","clear","send","close"');
    expect(source).toContain("function eraseAt(");
    expect(source).toContain("strokes=history.pop()");
  });

  it("線が無くても見せられる (送っている間だけ押せない)", () => {
    expect(source).toContain('key==="send"?sending:');
    expect(source).toContain("if(!port||sending)return;");
  });

  it("画像が写るまで描き直す (WebKit は読み込み直後だと中の画像を落とす)", () => {
    expect(source).toContain("drawn!==previous&&tries<MAX_DRAWS");
  });

  it("送っている間は線を足させない", () => {
    expect(source).toContain("(event.button!==0&&event.button!==5)||sending");
    // 描いている途中の線も、送り始めたところで終える
    expect(source).toMatch(/sending=true;[^}]*current=null;/);
  });

  it("</body> の直前へ1回だけ入れる", () => {
    const once = injectDiagramSketchLayer(
      "<html><body><p>図</p></body></html>"
    );
    expect(once).toContain(`id="${DIAGRAM_SKETCH_LAYER_MARKER}"`);
    expect(once.indexOf(DIAGRAM_SKETCH_LAYER_MARKER)).toBeLessThan(
      once.indexOf("</body>")
    );
    expect(injectDiagramSketchLayer(once)).toBe(once);
  });
});
