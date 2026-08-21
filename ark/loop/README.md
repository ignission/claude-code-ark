# Ark Loop runtime data

Ark Loop の session data は XDG data home 配下に保存する。session directory とその
`errors/` は mode `0700`、`raw.log` と `summary.md` は mode `0600` で、実行 uid が
所有する non-symlink の regular path だけを受理する。

`errors/raw.log` は追記専用 JSONL である。1 entry の上限は 1 MiB、session 全体の
上限は 64 MiB とし、上限を超える新 entry だけを記録しない。既存 raw を truncate、
rotate、rewrite しない。capture、summary、restart は raw/summary の削除 API を
持たず、session 終了後も保持する。削除は Ark lifecycle が session directory 全体を
明示的に削除するときだけ行う。

機械 summary は時刻・locale 非依存で、raw の error 本文を含めず、必ず raw line
参照を持つ。LLM summary は `[loop.summarize] llm = true` と model、API key がすべて
揃った明示 opt-in の場合だけ試行する。Anthropic Messages API へ送る入力は機械
summary とそこに含まれる `errors/raw.log:Lx-Ly` 参照だけであり、raw error 本文、
`tool_input`、transcript path、credential は送らない。API の失敗や不正な応答では
公開済みの機械 summary をそのまま保持する。
