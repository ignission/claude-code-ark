import { afterEach, describe, expect, it } from "vitest";
import { readClipboardImages } from "./clipboard-images";

function stubClipboardRead(
  read: () => Promise<
    Array<{ types: string[]; getType: (type: string) => Promise<Blob> }>
  >
): void {
  Object.defineProperty(navigator, "clipboard", {
    value: { read },
    configurable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("readClipboardImages", () => {
  it("画像のクリップボードアイテムをFileに変換する (拡張子はMIMEタイプから決める)", async () => {
    const blob = new Blob(["dummy"], { type: "image/png" });
    stubClipboardRead(async () => [
      { types: ["image/png"], getType: async () => blob },
    ]);

    const files = await readClipboardImages();

    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("pasted-image.png");
    expect(files[0]?.type).toBe("image/png");
  });

  it("画像でないアイテムは無視する", async () => {
    stubClipboardRead(async () => [
      { types: ["text/plain"], getType: async () => new Blob(["x"]) },
    ]);

    const files = await readClipboardImages();

    expect(files).toEqual([]);
  });

  it("クリップボードに何も無ければ空配列を返す", async () => {
    stubClipboardRead(async () => []);

    const files = await readClipboardImages();

    expect(files).toEqual([]);
  });

  it("クリップボード読み取りの失敗はそのまま呼び出し側へ伝える (トーストの出し分けは呼び出し側の責務)", async () => {
    stubClipboardRead(async () => {
      throw new Error("denied");
    });

    await expect(readClipboardImages()).rejects.toThrow("denied");
  });
});
