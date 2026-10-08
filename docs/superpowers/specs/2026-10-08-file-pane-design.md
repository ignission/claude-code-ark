# 常駐するファイルペイン (ツリー + 軽い編集)

- 日付: 2026-10-08
- 状態: 実装する (ユーザー決定)

## 1. 目的

いまファイルは、端末・会話・ボードのリンクを踏んだときだけ、左ペインの端末側のタブとして開く。
読み取り専用で、リロードすると消え、会話モードから開くと左ペインが端末へ切り替わる。

これを、ボードと同じく常駐するペインにする。自分でツリーを辿って開け、その場で直して保存でき、
Claude が書き換えたら追従する。端末・会話とボードを見たまま、横にファイルを置けるようにする。

## 2. 決定事項

| 項目 | 決定 |
|---|---|
| 配置 | PC の `SplitViewPane` を 3 ペインにする。左 = 端末 / 会話、中 = ファイル、右 = 図 (ユーザー決定) |
| 開閉 | 上部バーの「図」の隣に「ファイル」のトグルを足す。2 つは独立に開閉する |
| 開き方 | ファイルペイン内のツリーと、従来のリンク (`ark:open-file`) の両方 (ユーザー決定) |
| 編集 | CodeMirror 6 での編集と Ctrl+S 保存 (ユーザー決定)。LSP・補完・横断検索は持たない |
| 状態の持ち方 | ファイルタブを `sessionTabs` (端末のタブ列) から分離し、セッションごとの独立したリストにする |
| 永続化 | 開いているタブ・アクティブなタブ・ツリーの展開・幅・開閉を localStorage に持つ |
| 競合 | 読み取り時の mtime を保存時に添え、食い違えば拒否する。マージはしない |
| モバイル | 変えない。3 ペインは PC 専用で、モバイルは今の閲覧タブのまま |
| 出荷 | 1 本の PR にまとめる (ユーザー決定) |

## 3. 画面

```text
┌ 上部バー ──────────────── [端末|会話] ── … [ファイル] [図] […] ┐
├──────────────┬─┬─────────────────────────┬─┬──────────────┤
│ 端末 / 会話  │↔│ ツリー │ a.ts ● b.md  × │↔│ 図           │
│              │ │ src/   │────────────────│ │              │
│              │ │  a.ts M│  1 import ...  │ │              │
│              │ │  b.md  │  2 ...         │ │              │
└──────────────┴─┴─────────────────────────┴─┴──────────────┘
```

- ファイルペインは、左に折りたためるツリー、右にタブバーとエディタを置く
- リサイザは 2 本。ドラッグ中は 3 ペインとも `pointer-events-none` にする
  (ttyd と図の iframe が mousemove / mouseup を飲み込むため。既存の対処をそのまま広げる)
- 幅の制約: 左ペインは最小 360px、ファイルペインは最小 360px、図は従来どおり最小 320px。
  コンテナが狭くなって左ペインの最小幅を割るときは、ファイル、図の順に最小幅まで縮める。
  それでも足りないときは左ペインが縮む (どちらを閉じるかは利用者が決める。自動では閉じない)
- リンクを踏んだとき (live な `ark:open-file`) はファイルペインを自動で開く。
  リロード時の復元では開閉状態を変えない (図の `restoredOnLoad` と同じ理由)
- `openFileTab` が左ペインを端末へ切り替えていた処理 (`writeSavedSplitViewLeftMode("terminal")`)
  は PC では不要になるので外す。モバイルは左ペインのモードを見ていないので影響しない

## 4. 状態の持ち方

### 採る形: ファイルタブを端末のタブ列から分離する

`useViewerTabs` の `sessionTabs` は `[terminal, diagram?, file..., html...]` を 1 本の配列に持ち、
`activeTabIndex` 1 つで指している。図を右ペインへ移したとき、図タブを配列に残したまま
タブバーから隠したので、閉じた後の index 補正 (`correctActiveIndexAfterClose`) と、隠れタブに
着地したときの空白防止 (`TerminalPane` の `isActiveTabHidden`) が要るようになった。

ファイルを同じ形で中ペインへ移すと、隠れタブが 1 件から N 件になり、同じ種類の不具合が増える。
そこでファイルと HTML のタブは別のリストに分ける。

- `useFileTabs` (新規 hook): `Record<sessionId, { tabs: FileTab[]; activeId: string | null }>`
  - `FileTab = { id, kind: "file" | "html", filePath, targetLine?, targetEndLine? }`
  - アクティブは index ではなく id で持つ (閉じたときの補正が要らない)
  - 内容 (content / mtime / dirty) はタブではなく、タブを描くコンポーネントが持つ
- `useViewerTabs` に `onOpenFile` を足す。渡されていれば、`ark:open-file` を受けたときに
  自分のタブ列へは足さず `onOpenFile` を呼ぶ。`Dashboard` は PC のときだけ
  `useFileTabs.openFile` を渡す
- PC: `sessionTabs` に載るのは `terminal` と `diagram` だけになり、`TerminalPane` のタブバーは
  出なくなる (タブが 1 枚以下なら描かない既存の挙動)。中ペインの `FilePane` が
  `useFileTabs` のリストを描く
- モバイル: `onOpenFile` を渡さないので、従来の経路 (`sessionTabs` のファイルタブ +
  `file:read` → `file:content` + `FileViewerPane`) がそのまま動く。モバイルの部品は編集しない。
  PC とモバイルでタブの状態を共有しないが、同じ画面幅で両方を行き来する使い方は無い

### 採らない形: `sessionTabs` に残して隠す

差分は最小だが、上に書いた index 補正の特例を増やすことになる。

### 永続化

- キー: `ark-file-tabs:<worktreePath>` に `{ tabs: [{ kind, filePath }], activeFilePath }`
  (行の指定は保存しない)。ツリーの展開は `ark-file-tree-expanded:<worktreePath>`
- サーバー (SQLite) には持たせない。図の `lastDiagramPath` がサーバーにあるのは Claude の
  `board_open` がサーバー側で図を決めるためで、ファイルタブを決めるのはクライアントだけである
- 復元時にファイルが無くなっていたら、タブを開いたまま「ファイルが見つかりません」を出す
  (黙って閉じない。閉じるのは利用者)

## 5. サーバー

すべて ack (コールバック) で返す。既存の `file:read` → `file:content` は応答を `filePath` で
突き合わせる形で、同じファイルを続けて読むと取り違えうるため、新しい経路は ack にする。
`file:read` / `file:content` はモバイルが使うので残す。

| イベント | payload | 応答 |
|---|---|---|
| `file:open` | `{ sessionId, filePath }` | `{ ok: true, content, mimeType, size, mtimeMs, editable }` / `{ ok: false, error }` |
| `file:list` | `{ sessionId, dirPath }` | `{ ok: true, entries: [{ name, type: "dir" \| "file", gitStatus? }] }` |
| `file:write` | `{ sessionId, filePath, content, expectedMtimeMs, force? }` | `{ ok: true, mtimeMs }` / `{ ok: false, code: "conflict" \| "error", error, mtimeMs? }` |
| `file:subscribe` / `file:unsubscribe` | `{ sessionId, filePath }` | (なし) |
| `file:updated` (サーバー → クライアント) | `{ sessionId, filePath }` | |

### パスの検証

- `sessionId` から worktree をサーバー側で引く (既存の `file:read` と同じ)。クライアントの
  申告したパスは信用しない
- 読み取りは既存の `resolveSafePath` (worktree 内、または `/tmp` 配下)
- **書き込みは worktree 内だけ**。`/tmp` 配下と、worktree の `.git/` 配下は拒否する
- 書き込み先は既存のファイルに限る (新規作成・削除・リネームは範囲外)。realpath を取ってから
  worktree 内に収まることを確かめるので、worktree の外を指す symlink 経由では書けない

### 書き込み

- 上限 2MB、テキストの MIME のみ (`editable` はこの条件をサーバーが判定して返す)
- 同じディレクトリの一時ファイルへ書いてから `rename` する。直接書くと、Claude の Read や
  自分の watcher が書きかけを読みうる。mode は元のファイルのものを引き継ぐ
- `expectedMtimeMs` が現在の mtime と違えば `conflict` で拒否する。`force: true` なら照合を飛ばす
- 改行コードと末尾改行は変えない (CodeMirror の文書をそのまま書く。CRLF のファイルは
  読み取り時に検出した改行で書き戻す)

### 一覧

- 1 階層ずつ遅延取得する。ディレクトリが先、名前順
- `.git` は常に隠す。gitignore 対象は `git check-ignore --stdin` で 1 回にまとめて判定して隠す
  (`node_modules` を開いて固まるのを防ぐ)。隠しファイルは隠さない
- 変更の印は `git status --porcelain=v1 -z` から付ける (M / A / ? / D)。結果は worktree ごとに
  2 秒キャッシュし、非同期 (`execFile`) で呼ぶ。イベントループを塞がない
- 1 ディレクトリ 2,000 件で打ち切り、打ち切ったことを応答に載せる

### 監視

- `DiagramWatcher` (fs.watch + 1 秒 polling、mtime + size の変化で通知) を `FileWatcher` に
  改名して共用する。図に固有の処理は入っていない
- 購読は socket ごとに `[sessionId, filePath]` を鍵に持ち、切断時にすべて解除する。
  1 socket あたり 50 件を上限にする
- 自分の `file:write` による変化も `file:updated` で届く。クライアントは、届いたときに
  手元の mtime と一致していれば何もしない (サーバー側で抑止の集合を持たない)

### レート制限

`file:read` の「100ms 未満は拒否」は新しい経路には付けない。自動再読込とツリーの操作で
正常な利用が拒否されるため。認証を通ったクライアントは単一ユーザーである (CLAUDE.md
「単一ユーザー前提」)。

## 6. エディタ

- CodeMirror 6。言語定義は `@codemirror/language-data` で遅延ロードし、`FilePane` ごと
  `React.lazy` で分割する (初期バンドルに載せない)
- 行の指定 (`#L10-L24`) は、CodeMirror の行デコレーションでハイライトし、開始行へスクロールする
- `editable: false` (2MB 超・バイナリ・`/tmp` 配下) は読み取り専用で開く
- Markdown は「プレビュー / 編集」を切り替える。既定はプレビュー (今の `MarkdownRenderer`)
- 画像は今の `ImageRenderer`、HTML は今の `HtmlViewerPane` をそのまま中ペインで使う
- `FileViewerPane` (shiki) はモバイルが使い続けるので残す。PC の中ペインからは使わない
- 保存: Ctrl+S / Cmd+S。未保存のタブはタブバーに ● を出す。未保存のタブを閉じるときと、
  未保存があるままページを離れるとき (`beforeunload`) に確認する

### Claude の書き換えへの追従

| 手元の状態 | `file:updated` が届いたとき |
|---|---|
| 未編集 | 黙って読み直す。スクロール位置とカーソルは保つ |
| 編集中 | 上部にバナー「ディスク上で変更されました」+「再読込 (編集を捨てる)」「このまま編集」 |
| 保存して `conflict` | 同じバナー +「上書き保存」(`force: true`) |

表示していないタブは、表示したときに読み直す (購読は開いているタブすべてに張り、
読み直しだけを遅らせる)。

## 7. 部品の分け方

| 部品 | 役割 |
|---|---|
| `packages/server/src/lib/file-manager.ts` | 既存。`mtimeMs` / `editable` を足し、`writeFileToWorktree` と `listDirectory` を追加 |
| `packages/server/src/lib/file-watcher.ts` | `diagram-watcher.ts` を改名 |
| `packages/server/src/lib/file-handlers.ts` | socket ハンドラ (payload の型検証と、上の関数の呼び出し)。`index.ts` へは登録だけ置く |
| `packages/web/src/hooks/useFileTabs.ts` | タブのリストと永続化 |
| `packages/web/src/lib/file-tabs.ts` | タブ操作の純関数 (開く・閉じる・復元) |
| `packages/web/src/lib/split-pane-widths.ts` | 3 ペインの幅の丸めの純関数 |
| `packages/web/src/components/FilePane.tsx` | 中ペインの器 (ツリー + タブバー + 本体) |
| `packages/web/src/components/FileTree.tsx` | ツリー |
| `packages/web/src/components/FileEditor.tsx` | CodeMirror と、保存・競合・再読込 |

## 8. テスト

- 単体 (純関数とサーバー): 書き込みのパス検証 (`..` / `/tmp` / `.git` / worktree 外への symlink)、
  mtime の照合と `force`、一時ファイル + rename、一覧の並びと ignore、タブ操作、幅の丸め
- コンポーネント: `SplitViewPane` の 2 つのトグルと永続化、モバイルの合成後も
  ファイルタブが描かれること
- 実機 E2E (検証用のビルドと検証用のセッションで): リンクから開く → 編集 → 保存 →
  端末側でファイルを書き換える → 自動再読込 → 編集中に書き換える → バナー → リロードで復元

## 9. 範囲外

- ファイルの新規作成・削除・リネーム
- 横断検索、ファイル名検索
- 選択範囲を会話へ送る
- モバイルでの編集・ツリー
- 複数人の同時編集
