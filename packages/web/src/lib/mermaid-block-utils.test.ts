import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock は巻き上げられるため、参照する mock は vi.hoisted で先に作る
const { renderMock, initializeMock } = vi.hoisted(() => ({
  renderMock: vi.fn(),
  initializeMock: vi.fn(),
}));
vi.mock("mermaid", () => ({
  default: { render: renderMock, initialize: initializeMock },
}));

import { isMermaidCodeClass, renderMermaidToSvg } from "./mermaid-block-utils";

describe("isMermaidCodeClass", () => {
  it("language-mermaid を含むと true", () => {
    expect(isMermaidCodeClass("language-mermaid")).toBe(true);
  });
  it("他言語は false", () => {
    expect(isMermaidCodeClass("language-ts")).toBe(false);
  });
  it("className 無しは false", () => {
    expect(isMermaidCodeClass(undefined)).toBe(false);
  });
});

describe("renderMermaidToSvg", () => {
  beforeEach(() => {
    renderMock.mockReset();
    initializeMock.mockReset();
  });

  it("成功時は ok:true と svg を返す", async () => {
    renderMock.mockResolvedValue({ svg: "<svg>ok</svg>" });
    const r = await renderMermaidToSvg("flowchart LR\nA-->B", "m1");
    expect(r).toEqual({ ok: true, svg: "<svg>ok</svg>" });
  });

  it("strict で初期化する", async () => {
    renderMock.mockResolvedValue({ svg: "<svg/>" });
    await renderMermaidToSvg("flowchart LR\nA-->B", "m2");
    expect(initializeMock).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", startOnLoad: false })
    );
  });

  it("例外時は ok:false とエラー文言を返す（throw しない）", async () => {
    renderMock.mockRejectedValue(new Error("Parse error on line 1"));
    const r = await renderMermaidToSvg("bad", "m3");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Parse error");
  });
});
