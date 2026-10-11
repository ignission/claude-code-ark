---
paths:
  - "packages/server/src/lib/board-suggest-*.ts"
  - "packages/server/src/lib/jev-client.ts"
  - "packages/server/src/lib/auq-hook-bridge.ts"
  - "packages/web/src/components/BoardSuggestSettingsDialog.tsx"
---

# ボード提案 (Jev判定)

長い説明をチャットで読む負担を減らす機能。Claudeが返答を終えるたびに、Stop hook (`auq-hook-bridge.ts` が `--settings` で注入) がArkへ問い合わせ、Arkは直前のターンの本文をJev (TypeSafeの決定モデル。OpenRouter経由) に判定させる。図解すべきなら、hookが `{ decision: "block", reason }` を返し、Claudeは止まらずにその返答をデッキにして `board_open` で開く (`board-suggest-stop-hook.ts` / `jev-client.ts`)。

## 決まり

- **図を描くのはClaudeだけ。** 以前は返答のmarkdownをdoc型のボードへ機械変換していたが、チャットと同じ文章が別のペインに出るだけで、読み手に何も足さなかったので撤去した
- **tmuxには何も送らない。** send-keysで作図を頼むと、端末で入力中の下書きを `C-u` で消しうる (`bridgeStatus` は入力中をIDLEと報告する)。Stop hookのblockなら入力欄に触れない。blockの指示はtranscriptにisMetaのuser行として残り、会話ビューでは折りたたんだシステムの行になる
- Claudeへの入力に足すのは「外部の分類器がこの返答を図にすべきと判定した」ことだけで、SessionStart hookの作図規約を読み上げ直すものではない。規約だけだと、1,500文字を超える返答でClaudeが自分から `board_open` したのは、直近14日の192件中17件だった (実測)
- **Jevは生成しない分類器。** 「ボードのほうが読みやすいか」を1問だけ問い、確率だけが返る (1回200〜400ms、入力100万トークンで$0.042)。本文は末尾の6,000文字だけを送り、`provider.data_collection: "deny"` を付ける
- Decisions APIはalpha (`/api/alpha/decisions`) なので、endpointとmodelは `jev-client.ts` の定数に閉じ込める

## ターンの本文

hookの `transcript_path` の末尾4MBから組み立てる。最後の人の発話より後のtext blockを連結し、tool_resultとisMetaのuser行では区切らない。読めなければ `last_assistant_message` で判定する。

hookの受け口は長い返答を載せてくるので、全体の `express.json({ limit: "10kb" })` から外し、tokenを確かめてから4mbのparserを当てる。

## blockしない条件

- `stop_hook_active` (blockで続けたターンの終わり。無限ループを防ぐ)
- そのターンで既に `board_open` した
- 無効、鍵なし、Jevの失敗、閾値未満

hookのcurlは `-f -m 10` で、失敗やtimeoutのときは何も出さずに止まらせる。Jevの失敗は、セッションごとに1回だけログに出す。

## Stop hookが効くセッション

**Stop hookが効くのは、Arkがこの版になってからclaudeを起動したセッションだけ。** claudeは `--settings` のファイルを起動時に読むだけで、書き換えても読み直さない (実機で確認)。それより前から動いているセッションでは、claudeを起動し直すまでボード提案が動かない。

## 設定

- Arkメニュー (PC) / セッション一覧のスライダーアイコン (モバイル) の「ボード提案の設定」ダイアログで変える (`board-suggest-config.ts`)。次のターンから効く
- settingsに保存する値: 有効 `board_suggest_enabled`、閾値 `board_suggest_threshold` (既定0.7。0.5付近は「分からない」)、鍵 `board_suggest_api_key`
- 鍵の優先順: 設定画面 > `OPENROUTER_API_KEY` > `~/.config/openrouter/api-key`。どれも無ければ判定しない
- **鍵と `auq_hook_token` は `/api/settings` に載せない** (`isSecretSettingKey`)。`board-suggest:get` は鍵の末尾4文字だけを返す
- `ARK_FEATURE_BOARD_SUGGEST=false` で機能ごと止められる
