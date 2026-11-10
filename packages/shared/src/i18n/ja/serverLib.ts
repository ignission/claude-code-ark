export const serverLib = {
  /** 入力欄の候補に出す、組み込みのスラッシュコマンドの説明 */
  slashCommands: {
    clear: "会話履歴をクリア",
    compact: "履歴を要約して短縮",
    help: "ヘルプを表示",
    init: "CLAUDE.md を作成",
    review: "PR をレビュー",
    installGithubApp: "GitHub App をセットアップ",
    login: "Anthropic アカウントにログイン",
    logout: "ログアウト",
    config: "設定を表示/編集",
    cost: "セッション中のコストを表示",
    model: "使用モデルを切替",
    permissions: "権限を確認/変更",
    resume: "前回のセッションを再開",
  },
  /** tmux の読み取りの失敗の説明 */
  tmuxRead: {
    noSession: "TmuxManager が管理していないセッション ID です",
    tmuxFailed: (command: string, parts: string, detail: string) =>
      `tmux ${command} が失敗しました (${parts})${detail ? `: ${detail}` : ""}`,
    notSet: "変数が未設定です",
    noBuffer: "tmux ペーストバッファがありません",
    invalidPanePid: (raw: string) => `pane_pid を解釈できません: ${raw}`,
    procError: (code: string, message: string) =>
      `/proc の読み取りに失敗しました (${code}): ${message}`,
    unsupportedPlatform: (platform: string) =>
      `pane environ の読み取りは Linux 限定です (platform=${platform})`,
  },
  tmux: {
    specialKeyNotAllowed: (key: string) =>
      `許可されていない特殊キーです: ${key}`,
  },
  /** リモート画面の入力の検証 */
  screenInput: {
    nameRequired: "名前を入力してください",
    invalidHost: (kind: "SSH" | "VNC") =>
      `${kind} ホストはホスト名か IP アドレスで指定してください`,
    invalidSshUser: "SSH ユーザー名が不正です",
    invalidPort: (kind: "SSH" | "VNC") =>
      `${kind} ポートは 1〜65535 の整数で指定してください`,
    vncPasswordRequired: "VNC パスワードを入力してください",
    invalidInput: "入力が不正です",
    duplicateName: "同じ名前の画面が既に登録されています",
  },
  /** 使用量 (/usage) の取得の失敗 */
  usage: {
    launchSendFailed: (stderr: string) =>
      `claude起動コマンド送信失敗 (stderr: ${stderr})`,
    launchNotDetected: "claude CLIの起動を検出できませんでした",
    usageSendFailed: "/usage 送信に失敗しました",
    usageResultTimeout: "/usage 結果が時間内に表示されませんでした",
    usageParseFailed: "/usage 出力のパースに失敗しました",
  },
};
