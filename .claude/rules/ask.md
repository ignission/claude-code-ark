---
paths:
  - "packages/server/src/lib/ask-manager*.ts"
  - "packages/web/src/components/AskWindow.tsx"
  - "packages/web/src/hooks/useAsk.ts"
  - "packages/web/src/lib/ask-window.ts"
---

# Claudeに聞く (裏のClaude)

コマンドパレットで打った文を `Tab` で「聞く」と、表のセッションとは別の、裏で動く専用のClaudeが答え、浮かぶウィンドウ (`AskWindow`) に出る (`ask-manager.ts` / `useAsk`)。**表のセッションへは何も送らない** (進行中の会話に割り込まない)。

## 裏のClaudeの起動

- **裏のClaudeも、tmux上の対話版claude** (プラン枠のまま。Agent SDKと `claude -p` は使わない)。サイドバーに出ないセッションを1つだけ持つ
- tmuxのセッション名は `arkask-<session-id>`。**`ark-` で始めない**ので、サーバー起動時の復元の対象にならない
- **動かす場所は、Ark専用の空のフォルダ** (`~/.local/share/ark/ask`。`ARK_ASK_DIR` で替えられる)。表のセッションと同じフォルダで動かすと、会話ビューが「そのフォルダで一番新しいJSONL」として裏の会話を拾う。`data/` の下でも動かさない (リポジトリの中なので、その `CLAUDE.md` と設定を読み込む)
- **道具は持たせない** (`--tools ""` と `--strict-mcp-config`)。ファイルを読まず、何も書き換えず、コマンドも実行しない。許可の確認が出ないので、答える人がいなくても止まらない。`--tools ""` だけだと、利用者が設定しているMCPサーバーの道具が残る
- **claudeは `exec` で起動する。** シェルを残すと、claudeが終わったあとに、聞いた文がシェルのコマンドとして実行される。`exec` ならclaudeと一緒にtmuxセッションが終わり、次に聞いたときに作り直す
- **`--settings` は付けない。** Arkのhook (AUQと、ボード提案のStop hook) を裏の会話に効かせない。利用者自身の `~/.claude` の設定は効く
- **フォルダの信頼の確認には、裏で「はい」と答える。** 新しいフォルダではclaudeが起動時に確認を出し、既定は「いいえ」。Arkが作った空のフォルダで道具も無いので、その画面が出ている間だけ `Down` → `Enter` を送る。画面は「確認が出ているか」「入力欄が出たか」の有無だけを見て、内容は読まない

## 答えの読み取り

- **答えは、`--session-id` で決めたJSONLから読む** (「一番新しいファイル」を探さない)。人の発話とClaudeのtextだけを取り出し、`stop_reason: "end_turn"` でターンの終わりを知る
- 対話版は答えを書き終えてからJSONLに出すので、書かれるそばからは出せない

## 会話の状態

- 会話はサーバーが持ち、変わるたびに `ask:state` で丸ごと配る
- サーバーを再起動しても、残っているtmuxセッションの名前からsession-idを取り、同じJSONLを読み直す
- 「新しく聞く」はセッションを終わらせる (次に聞いたときに作り直す)
- **ウィンドウはダイアログにしない** (後ろの画面も、ノーマルモードのキーも止めない)
