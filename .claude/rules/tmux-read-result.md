---
paths:
  - "packages/server/src/lib/tmux-*.ts"
  - "packages/server/src/lib/bridge-collector.ts"
  - "packages/server/src/lib/session-orchestrator.ts"
---

# tmux読み取りの結果型 (`TmuxReadResult`)

`TmuxManager` の読み取り系 (`getEnv` / `getPaneEnv` / `getBuffer` / `capturePane` / `capturePaneVisible`) は、`string | null` ではなく `TmuxReadResult<string>` (`tmux-read-result.ts`) を返す。以前は**tmuxコマンドの失敗**と**値が無いこと**を同じ `null` に畳んでいて、セッションの消滅や復元の失敗の原因を、あとから追えなかった (#393)。

- 形は `{ ok: true, value }` か `{ ok: false, failure }`
- `failure.kind`:
  - `no-session`: 管理外のID
  - `tmux-failed`: 非0終了、起動の失敗、timeout。`status` / `signal` / `code` / `stderr` を持つ
  - `not-set` / `no-buffer` / `invalid-pane-pid` / `proc-error` / `unsupported-platform`
- **呼び出し側は、`not-set` / `unsupported-platform` / `no-buffer` を「想定内の値なし」として静かに扱う** (`no-buffer` のとき、`session:copy` は「バッファが空です」を返す)。それ以外は `describeTmuxReadFailure` で、理由をログに残す
- 1秒間隔のpollingの経路 (`getAllPreviews` とbridge-collector) は、`TmuxReadFailureReporter` で同じ失敗を1度だけ出し、回復したときも1行残す
- **`getEnv` は `show-environment -t <session>` の一覧から自前で探す。** 変数名を指定すると未設定のときもexit 1になり、tmuxの失敗と区別できない。同じ理由で、`getBuffer` は `show-buffer` の前に `list-buffers` で有無を見る
- 書き込み系 (`sendKeys` など) は、従来どおりthrowする
