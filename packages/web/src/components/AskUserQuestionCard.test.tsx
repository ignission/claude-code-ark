import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ActiveAuq } from "@/lib/ask-user-question-state";
import { AskUserQuestionCard } from "./AskUserQuestionCard";

const SINGLE: ActiveAuq = {
  toolUseId: "hook:1",
  questions: [
    {
      question: "ログイン画面のデザインはどちらにしますか？",
      header: "デザイン",
      multiSelect: false,
      options: [
        {
          label: "シンプル",
          description: "メールアドレスの入力欄を先に見せる",
        },
        { label: "並べる" },
      ],
    },
  ],
};

function render(auq: ActiveAuq, screenContext: string | null = null): string {
  return renderToStaticMarkup(
    createElement(AskUserQuestionCard, {
      socket: null,
      sessionId: "s1",
      auq,
      screenContext,
      onSendKey: vi.fn(),
    })
  );
}

describe("AskUserQuestionCard", () => {
  it("見出しに「確認待ち」のチップとheaderを出し、選択肢に番号バッジを付ける", () => {
    const html = render(SINGLE);

    expect(html).toContain('aria-label="質問"');
    expect(html).toContain("確認待ち");
    expect(html).toContain("デザイン");
    expect(html).toMatch(/>1<\/span>/);
    expect(html).toMatch(/>2<\/span>/);
    expect(html).not.toContain("❓");
  });

  it("その他 (自由入力) は点線の行で出す", () => {
    const html = render(SINGLE);

    expect(html).toContain('placeholder="その他 (自由入力、Enterで送信)"');
    expect(html).toContain("border-dashed");
  });

  it("複数選択の質問はチェックの形で出し、記号の絵文字を使わない", () => {
    const html = render({
      toolUseId: "hook:2",
      questions: [{ ...SINGLE.questions[0], multiSelect: true }],
    });

    expect(html).toContain("(複数選択可)");
    expect(html).toContain("回答を送信");
    expect(html).not.toMatch(/☐|☑/u);
  });

  it("複数選択の選択肢はaria-pressedで選択状態を読み上げに伝え、単問即送出の選択肢には付けない", () => {
    const multi = render({
      toolUseId: "hook:3",
      questions: [{ ...SINGLE.questions[0], multiSelect: true }],
    });
    expect(multi).toContain('aria-pressed="false"');

    const single = render(SINGLE);
    expect(single).not.toContain("aria-pressed");
  });

  it("等幅は「直前の画面」だけに使う", () => {
    expect(render(SINGLE)).not.toContain("font-mono");
    expect(render(SINGLE, "● 画面の内容")).toContain("font-mono");
  });
});
