// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VIEW_MODE_ICONS } from "./view-mode-icons";

describe("VIEW_MODE_ICONS", () => {
  it("会話・端末・図をPCと同じ lucide アイコンにする", () => {
    expect(renderToStaticMarkup(createElement(VIEW_MODE_ICONS.chat))).toContain(
      "lucide-messages-square"
    );
    expect(
      renderToStaticMarkup(createElement(VIEW_MODE_ICONS.terminal))
    ).toContain("lucide-square-terminal");
    expect(
      renderToStaticMarkup(createElement(VIEW_MODE_ICONS.board))
    ).toContain("lucide-workflow");
  });
});
