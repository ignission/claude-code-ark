export const voice = {
  title: "音声モード",
  /** 読み上げる文 */
  speech: {
    codePlaceholder: "コードは画面で",
    tablePlaceholder: "表は画面で",
    continued: "続きは画面で",
    answerOnScreen: "画面で答えてください",
    confirmOnScreen: "画面で確認が必要です",
    replyOnScreen: "返答は画面で",
    questionIntro: "Claudeから質問です。",
    options: (labels: string[]) => `選択肢は、${labels.join("、")}。`,
    /** 読み上げている文を画面に並べるときの区切り */
    sentenceJoiner: "",
  },
  /** 送らなかった指示に次の指示をつなぐときの区切り。前が文末で終わっているかで分ける */
  unsentJoiner: {
    afterSentenceEnd: "",
    midSentence: "。",
  },
  notice: {
    notAllowed:
      "マイクか音声入力が許可されていません。iPhoneの設定で、Safariのマイクと音声入力 (Siri) を確かめてください",
    network: "音声認識につながりません (network)",
    audioCapture: "マイクが使えません (audio-capture)",
    stopped: (error: string) => `音声認識が止まりました (${error})`,
    heldForConfirm: "確認が出ていたので送っていません",
    heldForDisconnect: "接続が切れていたので送っていません",
    heldForQuestion: "質問が来たので送っていません",
  },
  phase: {
    ready: "タップして話す",
    listening: "聞いています",
    confirming: "2秒後に送ります",
    thinking: "考えています",
    tool: "作業しています",
    waiting: "Claudeの返答を待っています",
    speaking: "読み上げています",
    screen: "画面で操作してください",
    paused: "一時停止しています",
  },
  overlay: {
    minimized: (label: string, hasUnsent: boolean) =>
      `音声モード: ${label}${hasUnsent ? "・未送信あり" : ""}`,
    back: "戻る",
    rateLabel: "読み上げの速さ",
    rate: (rate: number) => `${rate}倍`,
    exit: "音声モードを終える",
    unsentTitle: "送っていない指示",
    dismissUnsentLabel: "送っていない指示を消す",
    dismissUnsent: "消す",
    sendUnsentLabel: "送っていない指示を送る",
    sendUnsent: "送る",
    resume: "再開",
    talk: "話す",
    stopListening: "やめる",
    cancelSend: "取り消す",
    sendNow: "すぐ送る",
    talkMore: "追加で話す",
    stopSpeaking: "タップで止める",
  },
};
