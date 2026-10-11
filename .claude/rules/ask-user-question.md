---
paths:
  - "packages/server/src/lib/auq-*.ts"
  - "packages/web/src/components/AskUserQuestionCard.tsx"
  - "packages/web/src/lib/ask-user-question-state.ts"
---

# AskUserQuestion (AUQ)

対話版claudeは、AUQのtool_useを**回答か拒否が確定した瞬間**に、tool_resultとまとめてJSONLへ書く (実機で確認)。質問を表示している間、JSONLには質問も直前の会話も出ない。そのため次のように扱う。

- **質問の検出**: セッション起動時に `--settings` で注入するPreToolUse hook (`auq-hook-bridge.ts`) が、`tool_input.questions` を `/api/internal/auq-event` へPOSTする。サーバーは `session:auq` を送り、クライアントがカードを出す
- **質問の文脈**: hookを受けた時点のtmuxの画面をcaptureし、verbatimでカードに添える (「直前の画面」)。解釈もパースもしない
- **回答**: カードからtmuxへキーを送る
  - 単問のsingle: 数字を1回
  - multiSelect: 数字でトグル → Right → Reviewで数字の1
  - 自由入力: 数字 → literal → Enter
- **カードを閉じる**: JSONLに解決のイベントが出たとき (`hasResolvedAuqSince`)
- permission promptなど、AUQ以外の待ちはAWAITINGのバナーで扱う ([1][2] のクイックキーと、ターミナルへの誘導)
