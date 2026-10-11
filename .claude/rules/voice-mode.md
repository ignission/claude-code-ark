---
paths:
  - "packages/web/src/components/VoiceModeOverlay.tsx"
  - "packages/web/src/hooks/useVoiceMode.ts"
  - "packages/web/src/lib/voice-*.ts"
  - "packages/web/src/lib/browser-speech.ts"
  - "packages/web/src/lib/speech-text.ts"
  - "packages/server/src/lib/voice-diagnostic.ts"
---

# 音声モード (iPhone)

会話モードの1タップの操作から、全画面の音声モードに入る。

- 話した指示は、2秒の取り消しの猶予を置いてから送る
- **読み上げるのは、Claudeがターンを終えた返答だけ** (JSONLの `stop_reason: "end_turn"`)。ツール実行の合間の独り言とsubagentの発言は読まない。「音声モードに入った後」の判定は `lib/voice-turn-signals.ts` の冒頭にある
- 質問 (AUQ) と権限確認は読み上げて、操作は画面に回す
- **使うのは、ブラウザ内蔵の音声認識と読み上げだけ。** 画面を点けて、Arkを前面に出している間だけ動く
- `voice:diagnostic` は、サーバーのログに1行出すだけの診断。本文は送らない
