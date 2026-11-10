export const chat = {
  send: "送信",
  sending: "送信中",
  composer: {
    message: "メッセージ",
    placeholderMobile: "メッセージを入力",
    placeholder: "メッセージを入力 (Enterで送信、Shift+Enterで改行)",
    placeholderWithUpload:
      "メッセージを入力 (Enterで送信、Shift+Enterで改行。画像はD&D・貼り付けも可)",
    attachFile: "ファイルを添付",
    attachFileHint: "ファイルを添付 (D&D・貼り付けも可)",
    quickActionHint: (label: string) => `${label} (入力欄の文が対象)`,
    dropHere: "ここにドロップ",
    unsupportedFile: (name: string) => `${name}: 未対応のファイル`,
    uploadFailed: (name: string, reason: string) =>
      `${name}: アップロード失敗 (${reason})`,
    clipboardNoImage: "クリップボードに画像がありません",
    clipboardReadFailed: "クリップボードを読み取れませんでした",
    scrollToLatest: "最新まで一気にスクロール",
  },
  messages: {
    claudeWorking: "Claudeが作業しています",
    thinking: "考えています",
    working: "作業しています",
    openTerminal: "端末を開く",
    fileNotFound: "ファイルが見つかりません",
    externalImageBlocked: "モデル出力由来の外部画像は自動表示しません",
    image: "画像",
    compacted: "会話を要約しました (/compact)",
    questionCancelled: "質問はキャンセルされました",
    questionAnswered: "質問への回答",
    running: "実行中:",
    statusCompleted: "完了",
    statusFailed: "失敗",
    statusKilled: "停止",
    taskNotification: "作業の通知",
    system: "システム",
    toolCalls: (count: number) => `作業${count}件`,
    subagent: (count: number) => `サブエージェント (${count}件)`,
    noHistory: "このセッションの履歴はまだありません",
  },
  awaiting: {
    title: "Claudeが入力を求めています",
    sendDigit: (digit: string) => `${digit}を送信 (選択肢ジャンプ/トグル)`,
    focusUp: "フォーカスを上へ",
    focusDown: "フォーカスを下へ",
    nextTab: "次のタブ / Submitへ",
    toggleCheck: "チェックをトグル",
    selectFocused: "フォーカス中の項目を選択/確定",
    freeText: "自由入力",
    freeTextPlaceholder:
      "自由入力: 先にType somethingの番号を押してから入力 (Enterで確定)",
    submitFreeText: "入力して確定",
  },
  terminal: {
    title: "端末",
    close: "端末を閉じる",
    copyBuffer: "端末のバッファをコピー",
    reload: "端末を再読み込み",
    bufferCopied: "端末のバッファをコピーしました",
    nothingToCopy: "コピーできる内容がありません",
    copyBufferFailed: "バッファをコピーできませんでした",
    starting: "端末を起動しています",
  },
  panel: {
    label: "パネル",
    open: "パネルを開く",
    close: "パネルを閉じる",
    views: "パネルの表示",
    resize: "左右の幅を調整",
    tabBoard: "図",
    tabFiles: "ファイル",
  },
  viewer: {
    diagram: "図",
  },
  upload: {
    tooLarge: (name: string, sizeMb: string) =>
      `${name}: 10MBを超えています（${sizeMb}MB）`,
    unsupportedType: (name: string, mime: string) =>
      `${name}: 未対応の形式です（${mime}）`,
    unsupportedFile: "未対応のファイルです",
    readFailed: (name: string) => `${name}: 読み込みに失敗しました`,
    uploadFailed: "アップロードに失敗しました",
    dropToSend: "ファイルをドロップして送信",
    sendFilesTitle: (count: number) => `ファイルを送信（${count}件）`,
    removeFile: "このファイルを取り除く",
    messagePlaceholder: "メッセージを追加（任意）",
    sendingButton: "送信中...",
  },
  shortcuts: {
    title: "メッセージショートカット",
    buttonLabel: "メッセージのショートカット",
    description:
      "選択するとセッションへ即送信されます。複数行可・末尾で Enter が押されます。",
    empty:
      "登録されたショートカットがありません。下のフォームから追加してください。",
    bodyPlaceholder: "送信本文（1〜4000字、複数行可）",
    addHeading: "新規追加",
    newPlaceholder: "送信本文（例: 現在のタスクの進捗を教えて）",
    add: "追加",
    deleteTitle: "ショートカットを削除",
    deleteConfirm: (preview: string) =>
      `「${preview}」を削除します。よろしいですか？`,
    deleteConfirmGeneric: "このショートカットを削除します。よろしいですか？",
    none: "ショートカットがありません",
    manage: "ショートカットを管理",
  },
  // 入力欄の左の「図解」「TODO」のボタン。prompt は押したときにClaudeへ送る文で、
  // 利用者の言語で話しかける
  quickActions: {
    label: {
      diagram: "ボードに図解させる",
      todo: "TODOに残させる",
    },
    prompt: {
      diagram: {
        alone: "直前の説明をボードに図解して。",
        withText: "これをボードに図解して。",
      },
      todo: {
        alone: "この会話で保留にした話題をTODOに残して。",
        withText: "これをTODOに残して。",
      },
    },
  },
  codeBlock: {
    copy: "コードをコピー",
    copied: "コピーしました",
    copyFailed: "コピーできませんでした",
  },
  mermaid: {
    renderFailed: (error: string) => `図の描画に失敗しました: ${error}`,
  },
};
