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
    ]) {
      expect(source).toContain(`"${type}"`);
    }
  });

  it("画像にする写しから、スクリプトと自分の部品と CSP を外す", () => {
    expect(source).toContain('"script,ark-sketch,meta[http-equiv]"');
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
