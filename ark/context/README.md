# Ark Context runtime data

## 有効化前に確認する repo の前提条件

Ark Context を有効化する対象 repo は、事前に次の条件をすべて満たす必要がある。
満たさない場合は settings を変更せず、その repo の context を無効化する。

- `.claude` と、存在する場合の `.claude/settings.local.json` は、実行ユーザーが所有する
  non-symlink の directory / regular file であり、group / other 書き込み可でないこと
- versioned な `.gitignore` に `.claude/settings.local.json` と
  `.claude/settings.local.json.ark-context-tmp` の完全一致行がそれぞれあること
- `.claude/settings.local.json` と `.claude/settings.local.json.ark-context-tmp` が
  Git に tracked されていないこと

有効化前に mode、`.gitignore` の2行、`git ls-files` の結果を確認する。たとえば
`.claude` が mode `775` の場合は group 書き込み可なので前提を満たさない。

Ark Context の session data は XDG data home 配下に保存する。session directory とその
`errors/` は mode `0700`、`raw.log` と `summary.md` は mode `0600` で、実行 uid が
所有する non-symlink の regular path だけを受理する。

session init は mode `0600` の空の `artifacts/index.md` と session 固有の
`failures-inbox.md` も作る。artifact の目次行は `- artifacts/<path> — <1行要約>`
とし、handoff はこの形式だけを取り込む。

## SessionStart の task 規約

Claude Code adapter は `SessionStart` に agent 非依存の
`hooks/inject-context-rules.sh` を接続し、10則に続けて `task.md`、`artifacts/`、
`artifacts/index.md`、`knowledge/failures.md`、`failures-inbox.md` の絶対 path を
session directory の1ブロックとして `additionalContext` に渡す。
`knowledge/failures.md` の行だけは安全な snapshot が非空のときに出し、それ以外の
4 path は常に出す。Goal が空なら最初のユーザー要求から Goal と
Plan を起票する指示を、埋まっていれば現在の Goal / NOW を添える。`task.md` 自体には
規約本文を展開せず、`templates/context-rules.md` の絶対 path だけを1行で置くため、
recitation の `## Goal` / `## Plan` parse 境界は増えない。

レビュー session は `session-init.sh --review` で作る。通常の任意 Plan の代わりに固定の
6観点を checkbox として持ち、session ID の SHA-256 を seed に提示順だけを変える。
同じ session ID では順序が安定し、観点集合は変化しない。

`errors/raw.log` は追記専用 JSONL である。1 entry の上限は 1 MiB、session 全体の
上限は 64 MiB とし、上限を超える新 entry だけを記録しない。既存 raw を truncate、
rotate、rewrite しない。capture、summary、restart は raw/summary の削除 API を
持たず、session 終了後も保持する。削除は Ark lifecycle が session directory 全体を
明示的に削除するときだけ行う。

機械 summary は時刻・locale 非依存で、raw の error 本文を含めず、必ず raw line
参照を持つ。LLM summary は `[context.summarize] llm = true` と model、API key がすべて
揃った明示 opt-in の場合だけ試行する。Anthropic Messages API へ送る入力は機械
summary とそこに含まれる `errors/raw.log:Lx-Ly` 参照だけであり、raw error 本文、
`tool_input`、transcript path、credential は送らない。API の失敗や不正な応答では
公開済みの機械 summary をそのまま保持する。

## 横断 knowledge の ownership

| path | owner / writer | 用途 |
| --- | --- | --- |
| host failures.md | 人間だけ | レビュー済みの curated 正本 |
| session knowledge/failures.md | session init だけ | init 時点の curated 正本の snapshot。agent と hook は論理 read-only として扱う |
| session failures-inbox.md | agent、init | agent が候補を書く session 固有の受け皿。init は mode `0600` で作成 |
| host failures-inbox.md | lifecycle の候補 append と人間の整理 | 機械 summary と session inbox の候補を受ける唯一の自動出力先 |

agent と hook は host / session の failures.md を編集せず、agent は host inbox にも
直接書かない。teardown と次回 init の孤児回収は session inbox が安全な regular file・
mode `0600`・UTF-8・最大 64 KiB の場合だけ、knowledge lock 下で内容 SHA-256 marker を
付けて host inbox へ追記する。上限超過は切り詰めず候補全体をスキップする。raw log や機械・LLM
summary から curated 正本へ直接昇格する経路、および候補を意味的に自動統合する経路は
持たない。marker による重複排除は、同じ evidence block の再 append を防ぐためだけに
使う。

人間による昇格は次の順序で行う。

1. inbox 候補の evidence と参照先を確認する。
2. credential、個人情報、その他の機密情報が含まれないことを確認する。
3. curated failures.md の既存項目との意味的な重複を確認する。
4. 再現性と、別 session でも避ける価値があることを確認する。
5. 採用する知見だけを failures.md へ手編集する。
6. 採用済みまたは却下した候補を failures-inbox.md から手編集する。

## handoff の扱い

各 session の handoff.md は Goal、完了 Plan、未完了 Plan、現在の NOW、artifact
path と一行要約、error summary path、次の最小 action、WORK_ID、session ID を固定順で
持つ。artifact 本文、raw error、flow の control-plane JSON は含めず、level-2 見出しも
生成しない。

次 session の人間 operator が /flow --resume の前に読み、必要な項目を助言情報として
モデルへ提示する。phase / gate の正本は flow state であり、handoff と自動 merge、
相互上書きしない。モデルや /flow --resume が handoff を自動 Read する規則は #334
の範囲であり、ここでは追加しない。

## 足場の撤去観測

recitation、summary 継承、artifact / index、review rotation、Stop / handoff は一度に
一要素だけを実 session で無効化し、少なくとも 3 日かつ 3 session 観察する。観察する
劣化は順に Goal 逸脱、同種 error の再発、長出力後の参照回収失敗、観点漏れ、再開後の
誤 action / 未完了 Plan 放置とする。定量値は人間判断の補助に留め、統計閾値を撤去条件に
しない。効果が不明なら撤去し、判断・観察期間・確認した劣化だけを commit または Issue
へ残す。breaker、kill switch、loop-exclude の作動条件はこの観測で変更しない。

## 旧 `ark/loop` 名前空間との非互換

この runtime は `$XDG_DATA_HOME/ark/context/` を使う。旧 `ark/loop/` 配下の
session、knowledge、ownership manifest、config は**検出も移行もしない**。

改名時点で本番データが存在しなかったため（ハーネスは Ark へ未配線で、
fixture でしか動いていなかった）、移行処理は意図的に実装していない。

万一、旧名前空間の state を持つ環境がある場合は次の点に注意すること。

- 旧 ownership manifest が見えないため、対象 repo の `.claude/settings.local.json`
  に残った旧 hook（`ark/loop/...` を指すもの）は teardown で除去されない。
  **手動で削除する必要がある**
- 旧 `failures-inbox.md` の marker は prefix が異なるため重複排除が効かず、
  同じ候補が再追加される
- 旧 `$XDG_DATA_HOME/ark/loop/` と `$XDG_CONFIG_HOME/ark/loop/` は
  参照されなくなるので、不要なら手動で削除する
