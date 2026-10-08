# Git タブ (コミットグラフと差分の閲覧)

- 日付: 2026-10-08
- 状態: 実装する (ユーザー決定)
- 手本: Fork (git-fork.com) のメイン画面。ファーストビューはコミット一覧 (ユーザー決定)

## 1. 目的

PC の作業エリアのタブを「図 / ファイル / Git」にする。Claude がコミットやブランチ操作をしたあと、
「このセッションの worktree で何が起きたか」を、端末で `git log` を打たずに確かめられるようにする。

## 2. 決定事項

| 項目 | 決定 |
|---|---|
| 配置 | 作業エリアの 3 つ目のタブ「Git」。PC のみ |
| ファーストビュー | コミット一覧 (全ブランチ・グラフ付き)。先頭に「未コミットの変更」の行 |
| 範囲 (この PR) | 見る機能だけ: グラフ、ref の札、サイドバー (ブランチ / リモート / タグ / スタッシュ)、コミットの詳細、ファイルごとの差分、未コミットの変更 (ステージ済み / 未ステージ) |
| 範囲外 (次の PR) | ステージ、コミット、破棄、チェックアウト、ブランチ作成、fetch / pull / push、スタッシュ操作 |
| 差分の表示 | `@codemirror/merge` の `unifiedMergeView` (読み取り専用)。ファイルタブのエディタと同じ見た目と配色 |
| 追従 | Gitタブが見えている間だけ3秒ごとに指紋 (HEAD・いまのブランチ・ref・status・indexのblob・変更中のファイルのmtimeと大きさ) を問い合わせ、変わったら読み直す |
| 対象 | セッションの worktree。`sessionId` からサーバー側で引く (クライアントのパスは信用しない) |

操作を後に回すのは、破棄やチェックアウトが取り消せず確認の設計が要るため。見た目と閲覧を先に実機で固める。

## 3. 画面

```text
┌ [図] [ファイル] [Git]                                          × ┐
├───────────┬──────────────────────────────────────────────────────┤
│ 変更 (3)  │ [絞り込み…                                      ] ↻ │
│ すべての… │ ○     未コミットの変更 (3)                           │
│ ブランチ  │ ●─┐   [main] [origin/main] ピークの見出しを…  S 3時間前│
│ ✓ main    │ │ ●   [feat/x] アイコンを出す                 S 昨日  │
│   feat/x  │ ●─┘   常駐するファイルペインを追加            S 昨日  │
│ リモート  ├──────────────────────────────────────────────────────┤
│  origin   │ [コミット] [変更 4]                                  │
│ タグ      │ M FilePeek.tsx  +57 −38 │ (unified diff)             │
│ スタッシュ│ A FileIcon.tsx  +80     │                 ↗ ファイルで開く │
└───────────┴─────────────────────────┴────────────────────────────┘
```

- 左: サイドバー (幅 180px、折りたためる。`ark-git-sidebar-collapsed`)
- 右上: コミット一覧。右下: 選んだコミット (または未コミットの変更) の詳細。上下の境界はドラッグで動かせる
  (`ark-git-detail-height`、既定は 45%)
- 何も選んでいないときは HEAD を選ぶ

### コミット一覧

- 1 行 28px。左からグラフ、ref の札、件名、作者の頭文字の丸、相対時刻 (title に絶対時刻と短いハッシュ)
- グラフ: レーンごとに色を変える (8 色を循環)。コミットは丸、マージは二重丸、HEAD は塗りを強くする
- ref の札: ローカルブランチ (HEAD は太字 + ✓)、リモート、タグ、スタッシュを色で分ける
- 300 件ずつ読み、末尾までスクロールしたら続きを読む
- 絞り込み: 件名・作者・ハッシュの部分一致 (読み込み済みの範囲)。絞り込み中はグラフを描かない
- ↑↓ で選択を動かせる (`role="listbox"` / `role="option"`)

### サイドバー

- 「変更 (n)」「すべてのコミット」
- ブランチ (ローカル。上流との ahead / behind を `↑2 ↓1` で出す)、リモート、タグ、スタッシュ
- 押すと、そのコミットを一覧で選んでスクロールする (読み込み済みに無ければ読み足す。上限 3,000 件)

### 詳細

- 「コミット」: 件名、本文、作者、日時、ハッシュ (コピーできる)、親 (押すと移る)、ref
- 「変更」: 左にファイル一覧 (状態 A / M / D / R、パス、+ / −)、右に選んだファイルの差分。
  「ファイルで開く」で `ark:open-file` を投げる (ファイルタブへ切り替わる)
- 未コミットの変更: ファイル一覧を「ステージ済み」「変更」「未追跡」に分ける
- バイナリ、2MB 超、片側が無い (追加 / 削除) ファイルはその旨を出し、差分は片側だけで描く

## 4. サーバー

`packages/server/src/lib/git-view.ts` (git の読み取り) と `git-view-handlers.ts` (socket)。
すべて ack。git は `execFile` の非同期で呼び、`-c core.quotepath=off`、`--no-optional-locks`
(Claude の git 操作と index.lock を取り合わない) を付ける。出力は `-z` か制御文字区切りで読む。

| イベント | payload | 応答 (`ok: true` のとき) |
|---|---|---|
| `git:log` | `{ sessionId, skip, limit }` | `{ commits: GitCommit[], hasMore }` |
| `git:refs` | `{ sessionId }` | `{ head: { sha, branch \| null }, branches, remotes, tags, stashes }` |
| `git:status` | `{ sessionId }` | `{ staged, unstaged, untracked: GitFileChange[] }` |
| `git:commit` | `{ sessionId, sha }` | `{ commit: GitCommitDetail, files: GitFileChange[] }` |
| `git:file-diff` | `{ sessionId, target, path, oldPath? }` | `{ oldContent, newContent, binary, tooLarge }` |
| `git:fingerprint` | `{ sessionId }` | `{ fingerprint: string }` |

- `git:log`: `git log --all --date-order` (スタッシュの内部コミットを除くため `--exclude=refs/stash` を
  `--all` の前に置く)。`limit` は最大 500
- `target` は `{ kind: "commit", sha }` / `{ kind: "staged" }` / `{ kind: "unstaged" }` / `{ kind: "untracked" }`。
  コミットは第 1 親との差 (ルートコミットは空との差)
- `sha` は `/^[0-9a-f]{7,40}$/` だけ通す。`path` / `oldPath` は `..` を含まない相対パスだけ通し、
  必ず `--` の後ろに置く (オプションとして解釈させない)
- 内容は 2MB を超えたら `tooLarge`、NUL を含めば `binary` として本文を返さない
- `git:fingerprint`: 次をつないだもののハッシュ
  - `git rev-parse HEAD`、`git symbolic-ref -q HEAD` (detachedでは空)、`git for-each-ref` の出力
  - `git status --porcelain=v1 -z --untracked-files=all`
  - `git diff --cached --raw -z --no-abbrev` と `git diff --raw -z --no-abbrev` (indexのblobのid。
    ステージし直しを拾う)
  - statusが「作業ツリー側が変わっている」または「未追跡」と報告したパスの `lstat` のmtimeと大きさ
    (2,000パスまで。消えたファイルは決まった印)。変更済みのファイルの再編集はstatusの出力を変えない
- 競合中 (unmerged) のパスは `git:status` の `unstaged` に1回だけ `U` で出す。`staged` / `unstaged` の
  差分はours (ステージ2。無ければステージ1、どちらも無ければ空) と作業ツリーの差
- 作業ツリーのシンボリックリンクはたどらず、行き先の文字列を内容にする
- 失敗は `{ ok: false, error }`。git リポジトリでない worktree も同じ形で返す

型は `packages/shared/src/types.ts` に置く (下記)。

```ts
export interface GitCommit {
  sha: string;
  parents: string[];
  subject: string;
  authorName: string;
  authorEmail: string;
  /** 作者日時 (UNIX 秒) */
  authorTime: number;
  refs: GitRef[];
}
export interface GitRef {
  kind: "head" | "branch" | "remote" | "tag" | "stash";
  /** 表示名 (`main` / `origin/main` / `v1.0`) */
  name: string;
}
export interface GitCommitDetail extends GitCommit {
  body: string;
  committerName: string;
  committerTime: number;
}
export interface GitFileChange {
  path: string;
  /** リネーム・コピーの元 */
  oldPath?: string;
  status: "A" | "M" | "D" | "R" | "C" | "T" | "U" | "?";
  /** バイナリは null */
  added: number | null;
  removed: number | null;
}
export interface GitBranch {
  name: string;
  sha: string;
  current: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
}
export interface GitRefs {
  head: { sha: string | null; branch: string | null };
  branches: GitBranch[];
  remotes: { name: string; sha: string }[];
  tags: { name: string; sha: string }[];
  stashes: { name: string; sha: string; subject: string }[];
}
export type GitDiffTarget =
  | { kind: "commit"; sha: string }
  | { kind: "staged" }
  | { kind: "unstaged" }
  | { kind: "untracked" };
```

## 5. クライアント

| 部品 | 役割 |
|---|---|
| `lib/git-api.ts` | ack を Promise にする薄い層 (5 秒で timeout。`file-api.ts` と同じ作り) |
| `lib/git-graph.ts` | レーン割り当ての純関数。`layoutGraph(commits)` が行ごとの「自分の列・色・上下へ伸びる線」を返す |
| `components/git/GitPane.tsx` | タブの器。データの取得・選択・追従 |
| `components/git/GitSidebar.tsx` | サイドバー |
| `components/git/GitCommitList.tsx` | 一覧とグラフの行 (行は固定高、見えている範囲だけ描く) |
| `components/git/GitGraphCell.tsx` | 1 行ぶんのグラフの SVG |
| `components/git/GitCommitDetail.tsx` | 詳細 (コミット / 変更) |
| `components/git/GitDiffView.tsx` | `unifiedMergeView` の包み。`React.lazy` で読む |

- `SplitViewPane` の作業エリアのタブへ「Git」を足す。`gitPane?: (visible: boolean) => ReactNode` を受け、
  ファイルタブと同じく、初めて見せるまでマウントせず、見せた後は `hidden` で残す
- `GitPane` は見えている間だけ指紋を 3 秒ごとに問い合わせる。隠れている間は何もしない
- グラフの割り当て: コミットを上から順に見て、「次に来るはずのハッシュ」をレーンごとに持つ。
  自分を待っているレーンのうち最も左を自分の列にし、同じハッシュを待つ他のレーンはそこで合流して閉じる。
  第 1 親は自分の列を引き継ぎ、第 2 親以降は既に待っているレーンがあればそこへ、無ければ空いている列へ線を伸ばす。
  読み込みが途中で切れていても破綻しない (親が未読のレーンは下へ伸ばしたままにする)

## 6. テスト

- サーバー: 一時リポジトリで、log (並び・ref・マージの親・スタッシュが混ざらない)、refs (ahead / behind)、
  status (ステージ済み / 未ステージ / 未追跡 / リネーム)、commit (ルートコミット・マージ・numstat)、
  file-diff (追加・削除・リネーム・バイナリ・巨大)、入力の拒否 (`sha` と `path`)
- `git-graph`: 一直線、分岐と合流、同時に 3 本、オクトパスマージ、途中で切れた履歴、複数のルート
- コンポーネント: 一覧の選択とキーボード、サイドバーから飛ぶ、詳細のタブ、未コミットの行、絞り込み
- 実機: 本番ビルドで、このリポジトリのグラフが `git log --graph` と矛盾しないこと、差分が出ること、
  コミットすると 3 秒ほどで一覧が更新されること

## 7. 範囲外

- git の操作 (次の PR)
- blame、ファイルの履歴、コミット間の比較、サブモジュール、LFS の中身
- モバイル
