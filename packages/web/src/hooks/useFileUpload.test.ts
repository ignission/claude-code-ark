import { describe, expect, it } from "vitest";
import { validateFile } from "./useFileUpload";

function makeFile(name: string, type: string, size = 1024): File {
  const file = new File([new Uint8Array(size)], name, { type });
  return file;
}

describe("validateFile", () => {
  it("Excelのブックを受け付ける", () => {
    expect(
      validateFile(
        makeFile(
          "売上.xlsx",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
      ).ok
    ).toBe(true);
    expect(
      validateFile(makeFile("売上.xls", "application/vnd.ms-excel")).ok
    ).toBe(true);
  });

  it("MIMEが曖昧でも拡張子がxlsxなら受け付ける", () => {
    expect(
      validateFile(makeFile("売上.xlsx", "application/octet-stream")).ok
    ).toBe(true);
  });

  it("未対応の形式は理由を返す", () => {
    const result = validateFile(
      makeFile("app.exe", "application/x-msdownload")
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("未対応の形式です");
  });
});
