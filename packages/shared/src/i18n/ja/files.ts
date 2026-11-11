export const files = {
  /** 未保存の編集があるタブやピークを閉じる前の確認 */
  confirmDiscard: "保存していない変更があります。閉じますか？",
  connecting: "接続中…",
  cannotOpen: "ファイルを開けません",
  api: {
    noResponse: "サーバーから応答がありません",
  },
  editor: {
    loading: "読み込み中…",
    retry: "再試行",
    readOnly: "読み取り専用",
    markdownView: "Markdown の表示",
    preview: "プレビュー",
    edit: "編集",
    saveShortcut: "保存 (Ctrl+S)",
    changedOnDisk: "ディスク上で変更されました",
    reloadDiscard: "再読込 (編集を捨てる)",
    overwrite: "上書き保存",
    keepEditing: "このまま編集",
    saveFailed: (reason: string) => `保存できません: ${reason}`,
    cannotDisplay: "このファイルは表示できません",
  },
  pane: {
    expandTree: "ファイルツリーを開く",
    collapseTree: "ファイルツリーを折りたたむ",
    openFiles: "開いているファイル",
    unsaved: "未保存",
    closeTab: (name: string) => `${name} を閉じる`,
    empty: "ツリーからファイルを選ぶか、会話やボードのリンクを押すと開きます",
  },
  peek: {
    openInFiles: "ファイルで開く",
    close: "ピークを閉じる",
  },
  tree: {
    title: "ファイル",
    reload: "再読み込み",
    label: "ファイルツリー",
    truncated: "…件数が多いため一部だけ表示しています",
  },
  viewer: {
    binaryNoPreview: "バイナリファイルのプレビューはできません",
    imageFile: (name: string) => `画像ファイル: ${name}`,
  },
  html: {
    saveImage: "画像保存",
    copyToClipboard: "クリップボードにコピー",
    downloadPng: "PNG をダウンロード",
    copied: "画像をクリップボードにコピーしました",
    copyFailed: (reason: string) => `画像のコピーに失敗しました: ${reason}`,
    downloadFailed: (reason: string) =>
      `画像のダウンロードに失敗しました: ${reason}`,
    loadFailed: (reason: string) =>
      `HTMLファイルの読み込みに失敗しました: ${reason}`,
  },
};
