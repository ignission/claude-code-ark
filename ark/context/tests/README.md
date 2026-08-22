# ハーネステストの規約

`ark/context` と `.claude/hooks` の shell テストを書くときの規約。

CI は **`macos-latest`** で走る。ローカルの Linux で通っても macOS で落ちる問題を過去に
6 回踏んだ（`flock` 不在 / `stat -c` / `rg` 不在 / 一時パスの非正規 2 回 / インタプリタの
絶対パス）。うち 2 回はパス正規化という同一の欠陥の再発だった。

ここに書かれているのはすべて**実際に踏んだものの再発防止**であり、予防的な一般論ではない。

## 構成

```
run.sh            すべてのテストを順に実行する。新しいテストはここへ登録する
test-helper.sh    共通のアサーション。各テストが source する
test-*.sh         個別のテスト
fixtures/         入力データ
```

`test-helper.sh` が提供するもの:

| 関数 | 用途 |
| --- | --- |
| `assert_eq <説明> <期待> <実際>` | 値の一致 |
| `assert_success <説明>` | 直前の `run_case` が成功 |
| `assert_failure_reason <説明> <期待理由>` | 失敗理由の一致 |
| `run_case <コマンド...>` | 実行し `CASE_STATUS` / `CASE_STDOUT` / `CASE_STDERR` に格納 |
| `finish_tests <名前>` | 集計を出力し、失敗があれば非 0 で終了 |

`CTX_ZSH` に zsh のパスが入る（無ければ空）。zsh 用のケースは存在確認してから実行し、
無い環境では **SKIP と明示して**通す。

## 1. 一時ディレクトリは必ず正規化する

```bash
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)   # 必須
```

macOS では `/tmp` が `/private/tmp` への symlink で、`/var` も `/private/var` を指す。
git やその他のツールは解決済みパスを返すため、正規化しないと比較が一致しない。

正規化には **`pwd -P` を使う**。現行の macOS には `realpath` があり `readlink -f` も
使えるが、`pwd -P` は POSIX の範囲で追加コマンドに依存せず、bash と zsh の両方で同じに
振る舞う。**新しいコマンドを増やさないための選択**であり、`realpath` が存在しないから
ではない。

### パス比較で「正規パスであること」を要求しない

**検証する側も同じ罠を踏む。** 実装が受け取るパスは正規化されているとは限らないため、
「引数が正規パスと完全一致すること」を要求する**アサーション**は macOS で落ちる。
比較する前に両辺を同じ方法で正規化する。

これはテストの話。実装側が安全のために正規パスを要求している箇所
（`post-tool-use-failure.sh` / `summarize-errors.sh` / `handoff.sh` の
`canonical == input` 検査など）は別の目的を持つので、この規約の対象外。

### TypeScript のテスト fixture も正規化する

shell だけの話ではない。`os.tmpdir()` は macOS で `/var/...` を返し、実体は
`/private/var/...`。**`fs.mkdtempSync(path.join(os.tmpdir(), ...))` の戻り値は
非正規パス**になる。

```ts
// 正規化する
testRoot = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "ark-context-integration-"))
);
```

実害の例: `session-orchestrator-context.integration.test.ts` が macOS CI だけで
5 秒 timeout した。非正規な XDG パスを渡された `ark/context` が派生物の生成に失敗し、
owner marker が残り、その削除を待つ `waitFor` が期限切れになっていた。
**症状はタイムアウトで、原因はパスだった。**

Linux では `/tmp` が symlink ではないため再現しない。切り分けるときは
**TMPDIR を symlink にして 1 変数だけ動かす**。

```
修正前  TMPDIR 正規 → 通る 0.7 秒 / 非正規 → 落ちる 5.5 秒
修正後  TMPDIR 正規 → 通る 0.7 秒 / 非正規 → 通る  0.8 秒
```

**すべての fixture に必要なわけではない。** 正規化が要るのは、そのパスを
**パス検証を行うコードへ渡す**場合と、**パスを比較する**場合。単に読み書きするだけの
fixture は影響を受けない。

## 2. bash 3.2 で動く記法に限定する

macOS の `/bin/bash` は 3.2 系。次は使えない。

| 使えないもの | 代わりに |
| --- | --- |
| `mapfile` / `readarray` | `while IFS= read -r line; do ... done < file` |
| 連想配列 `declare -A` | 並列の配列か、区切り文字つきの文字列 |
| `${var^^}` / `${var,,}` | `tr '[:lower:]' '[:upper:]'` |
| `${var@Q}` などの変換 | 使わない |
| `&>>` | `>>file 2>&1` |

**開発機の新しい bash による `bash -n` では 3.2 非互換を検出できない。** bash 5 の `-n` は
上記すべてを status 0 で通す。

bash 3.2 自身の `-n` なら `&>>` だけは構文エラーとして検出できる（exit 2）。それ以外は
`-n` を通過し、実行時に初めて失敗する。

```
bash 3.2 -n   mapfile -t a < f      exit 0   （実行時 127: command not found）
bash 3.2 -n   declare -A m          exit 0   （実行時 2: invalid option）
bash 3.2 -n   echo ${v^^}           exit 0   （実行時 1: bad substitution）
bash 3.2 -n   echo hi &>> /tmp/x    exit 2   ← これだけ検出できる
```

したがって**確実に確かめるには bash 3.2 の実環境で実行する**（Docker の `bash:3.2` など）。

その際、`bash:3.2` イメージには `/bin/bash` が無く `/usr/local/bin/bash` にある。
`/bin/bash` を直書きしたハーネスは**全ケースが exit 127 になり、「すべて失敗した」ように
見える**。テスト環境の不備を実装の欠陥と読み違えないよう、必ず**通るはずのケース（陽性対照）**
を 1 つ混ぜる。

## 3. zsh でも同じ結果になることを確かめる

Ark はセッションを zsh で起動することがある。**bash と zsh の差は「エラーになる差」より
「黙って結果が変わる差」が危険**。

代表例: zsh は既定でクォートしない変数展開を単語分割しない（`SH_WORD_SPLIT` が無効）。
`set -- $value` や `for x in $value` が bash と違う結果になる。空白・タブ区切りの分割は
`IFS` を設定した `read` で行う。

**この差を自動で検査している仕組みは無い。** zsh を対象にするテストは `CTX_ZSH` を使って
明示的にケースを足すこと。`test-portable-commands.sh` が検査しているのは非移植コマンド、
絶対インタプリタ、`sed` の `\t` であって、単語分割ではない。

## 4. macOS に無いコマンドを前提にしない

過去に踏んだもの:

| コマンド | 状況 | 対処 |
| --- | --- | --- |
| `flock` | macOS に**存在しない** | `mkdir` による排他へ fallback |
| `stat -c` | GNU 専用。BSD は `-f` | 両方試す capability 検出 |
| `rg`（ripgrep） | CI ランナーに入っていない | `grep -E` を使う |

`jq` は **macOS の標準には含まれない**が、GitHub の `macos-latest` ランナーには入っている。
CI が通ることは、ユーザーの Mac で動くことを意味しない。`ark/context` は `jq` を前提条件
として明記し、不在時は記録を残す（#373 / #377）。

**capability 検出は「試して失敗したら次」の形にする。** OS 名で分岐すると、同じ OS でも
環境差がある場合に破綻する。

```bash
value=$(stat -c '%a' "$path" 2>/dev/null) \
  || value=$(stat -f '%Lp' "$path" 2>/dev/null) \
  || return 1
```

## 5. インタプリタの絶対パスを直書きしない

`/usr/bin/zsh` は Linux の位置で、macOS は `/bin/zsh`。`command -v` で解決する。

`/bin/bash` と `/bin/sh` は macOS / Linux の両方に存在するため直書きしてよい。ただし
コンテナ内は別（上記 `bash:3.2` の例）。

## 6. アサーションは契約に合わせる

**「あること」だけを見るテストは、中身が壊れても mode が変わっても通る。** 内容や権限が
契約に含まれるなら、そこまで比較する。

- 実行前の内容と mode を保存し、実行後に一致を確認する
- marker の存在ではなく、marker の**中身**を比較する

**存在・不在そのものが契約であるケースは、存在チェックで正しい。** 例えば「teardown 後に
owner が消えていること」「処理が継続して handoff が作られたこと」は存在が契約。
中身の比較を機械的に足す必要はない。

## 7. 「0 件」を根拠にするときは陽性対照を取る

`grep` が 0 件を返したことは「無い」ことの証明にはならない。**検索式が間違っていても
0 件になる。** 実際に、大文字小文字を区別する検索で残存を見逃し、「依存を切った」と
誤って報告したことがある。

「0 件だった」を結論に書く前に、**わざと 1 件ヒットする対象に同じコマンドを流して**
検索式が機能することを確かめる。

識別子の残存確認は `grep -rniE` を使い、`[A-Za-z_]*<語>[A-Za-z_]*` の形で前後の識別子ごと
拾って目視する。`\b` は `_` を単語構成文字とみなすため `\bLOOP_` は `CLAUDE_LOOP_` に
マッチしない。

## 8. 復元したことを確認してから次へ進む

対話シェルで `cp` が `cp -i` に alias されている環境があり、その alias が効く文脈では
プロンプトで止まって**上書きされないまま次へ進む**。

**復元・巻き戻しの手順**では次を守る。

- `command cp -f` / `command mv -f` / `command rm -f` を使って alias を迂回する
- 直後に `diff -q` で**実際に戻ったこと**を確認する

通常のファイル操作すべてに広げる必要はない。実害が出たのは**変異テストの復元**で、
復元を怠って試行同士が汚染され、**すべての変異が検出されたように見えた**ケース。

## 9. 検出力の要る変更では変異テストを行う

テストが実装の欠陥を実際に捕まえるか確かめたいときは、**守っている実装を壊して落ちること**
を確認する。落ちなければ、そのテストは何も守っていない。

```
1. 変異なしで通ることを確認
2. 実装の該当箇所を壊す
3. テストが落ちることを確認
4. 復元し、diff で一致を確認
5. 再度通ることを確認
```

すべての新規テストに必須ではない。**「このテストがあるから安全だ」と主張する場面**で行う。

## 10. 終了コードを潰さない

```bash
pnpm test | tail -3
```

`pipefail` が無効だと、これは `tail` の終了コードになる。テストスクリプト自身は
`set -uo pipefail` を使っているので影響を受けないが、**外から呼ぶとき（CI の一行コマンド、
python の `subprocess` で `shell=True`、ワンライナーの検証）は無効**なので注意する。

実際に、変異テストの結果を `pnpm vitest run | tail -3` で判定して**「変異が検出されなかった」
と誤った結論を出した**ことがある。出力を絞りたいならファイルへ落としてから読む。

`dd bs=N count=1` はパイプからの読み取りを切り詰めるため、`head -c` を使う。

## 11. run.sh へ登録する

テストを追加したら `run.sh` に足す。**登録し忘れたテストは一度も実行されない。**
`pnpm test:harness` から `run.sh` が呼ばれる。

`.claude/hooks/tests/` のテストも `pnpm test:harness` から呼ばれる（`package.json` を参照）。

## 参照

このリポジトリで実際に踏んだ失敗は
`$XDG_DATA_HOME/ark/context/knowledge/failures.md` に集約されている。
Ark Context が有効なセッションでは SessionStart で path が提示される。
