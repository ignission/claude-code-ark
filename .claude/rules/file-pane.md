---
paths:
  - "packages/server/src/lib/file-manager*.ts"
  - "packages/server/src/lib/file-handlers*.ts"
  - "packages/server/src/lib/file-watcher*.ts"
  - "packages/web/src/components/File*.tsx"
  - "packages/web/src/components/CodeEditor.tsx"
  - "packages/web/src/hooks/useFileTabs.ts"
  - "packages/web/src/hooks/useViewerTabs.ts"
  - "packages/web/src/lib/file-*.ts"
---

# ファイルペイン

PCの作業エリアの「ファイル」のタブ (`FilePane`) は、worktreeのファイルをツリー (gitignoreの対象は隠し、gitの変更の印を出す) から開き、CodeMirrorで編集してCtrl+S / Cmd+Sで保存する。Claudeも同じファイルを書き換えるので、書き込みと監視には、見ただけでは分からない決まりがある (`file-manager.ts` / `file-handlers.ts` / `FileEditor.tsx`)。

## 書き込み

- **書けるのは、worktree内の既存のファイルだけ。** 読み取りは `/tmp` 配下も通すが、書き込みは `/tmp` 配下とworktreeの `.git/` 配下を拒否する。新規作成、削除、リネームは持たない
- realpathを取ってからworktree内かを確かめる。worktreeの外を指すsymlinkを経由しても書けない
- **同じディレクトリの一時ファイルへ書いてから `rename` する。** 直接書くと、ClaudeのReadやファイルの監視が書きかけを読みうる。modeは元のファイルのものを引き継ぐ
- **読み取り時のmtime (`expectedMtimeMs`) を保存に添え、食い違えば `conflict` で拒否する。** マージはしない。利用者が「上書き保存」を選んだときだけ、`force: true` で照合を飛ばす
- 照合は、一時ファイルを書いたあと、`rename` の直前にもう一度行う (書いている間にClaudeが書き換えた分を潰さないため)。同じファイルへの保存は、サーバー内で直列にする
- **編集できるのは、2MB以下の、BOMなしUTF-8のテキストだけ** (`file:open` の `editable` をサーバーが判定する)。それ以外は読み取り専用で開く。UTF-16やShift_JISは読めた時点で文字が化けていて、書き戻すと元の内容を壊す

## 監視

- **監視 (`file:subscribe`) は、見えているタブ1枚にだけ張る。** 全セッションの `SplitViewPane` は常時マウントされ、`FilePane` も1度見せたら外さないので、開いているタブすべてに張るとサーバーの上限 (1 socketあたり50件) を超える
- 隠れていたタブは、見えたときに `file:open` し直してディスクと突き合わせる。未編集なら黙って読み直し、編集中ならバナーで「再読込」「上書き保存」を選ばせる。隠れたままのタブは読み込みもしない
- 自分の保存による `file:updated` も、サーバーは抑止しない。クライアントが、開き直した結果のmtimeが手元と同じなら捨てる (`decideOnDiskChange`)

## 作業エリアとタブ

- **右側は作業エリア1つで、タブで切り替える。** 当初の 左 | ファイル | 図 の3ペインは、1680pxの画面で3つ開くと会話のペインが最小幅の360pxまで縮んだ。図とコードを並べたいのは、図のリンクを踏んだ直後だけだった
- 作業エリアを閉じると `DiagramPane` は外すが、**1度見せた `FilePane` とピークは外さずに `hidden` で残す** (外すと未保存の編集が消える)。タブを替えるだけなら `DiagramPane` も外さない (iframeを作り直さない)
- **ファイルタブは `useFileTabs` が持ち、端末のタブ列 (`useViewerTabs` の `sessionTabs`) には載せない。** `sessionTabs` は1本の配列をindex 1つで指すので、隠れたタブを足すたびに「閉じたあとのindexの補正」と「隠れタブに着地したときの空白」の特例が増える。ファイルタブはidで指す別のリストにして、その補正を要らなくした
- PCでは `useViewerTabs` の `onOpenFile` へ、`ark:open-file` の行き先を決める関数を渡す。端末と会話のリンクは `useFileTabs.openFile` (「ファイル」のタブ) へ、図のリンクはピークへ送る
- モバイルは `onOpenFile` を渡さないので、従来の読み取り専用のタブ (`file:read` → `file:content` + `FileViewerPane`) のまま動く
- 行指定つきのリンク (`README.md#L10`) で開いたMarkdownは、プレビューではなく編集で出す (プレビューでは行を示せない)

## ピーク

- **図の中のコードリンクは「ピーク」で開く** (`FilePeek`)。`DiagramPane` が `ark:open-file` に `source: "board"` を付け、`Dashboard` がそれを見て、ファイルタブへ足さずにセッションごとのpeekへ入れる。`SplitViewPane` は「図」のタブの本体を左右に割り、図の横へ出す
- 中身はタブと同じ `FileEditor` で、編集も保存もできる。「ファイルで開く」でファイルタブへ移す (未保存の編集は、確認のうえ捨てる)
- 開けるのは1件だけで、リロードでは復元しない

## ファイルの種類のアイコン

material-icon-themeの一部だけを同梱する。ファイル名、拡張子、フォルダ名との対応表は `lib/file-icons.ts`、SVGの束ねは遅延読み込みの `lib/file-icon-assets.ts` (globのブレース内の一覧を手で持ち、対応表との一致をテストで見る)。表示は `FileIcon` (ツリーとタブ)。**足すときは、両方に同じ名前を足す。**
