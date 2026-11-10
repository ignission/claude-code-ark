export const dialogs = {
  about: {
    description:
      "ローカルで稼働する複数 Claude Code セッションを管理する Web UI。",
    thisMachine: "このマシン",
    bundledComponents: "同梱コンポーネント",
    licensesLoadFailed: (reason: string) =>
      `ライセンスを読み込めませんでした: ${reason}`,
    notPackaged: "このビルドにはバイナリを同梱していません。",
    noComponents: "同梱コンポーネントの登録がありません。",
    licenseUnavailable: "(LICENSEファイルがありません)",
  },
  claudeInstall: {
    title: "Claude CLI セットアップ",
    idle: "待機中",
    checking: "Claude CLI のインストール状態を確認しています...",
    alreadyInstalled: (path: string) =>
      `Claude CLI は既にインストール済みです: ${path}`,
    installing: "Claude CLI をインストール中...",
    completed: (path: string) => `インストールが完了しました: ${path}`,
    failed: (error: string) => `インストールに失敗しました: ${error}`,
  },
  folderBrowser: {
    title: "フォルダを選択",
    description:
      "ディレクトリを移動して、選択したいフォルダを開いた状態で「このフォルダを選択」を押してください。",
    currentPath: "現在のパス",
    goToParent: "親ディレクトリへ移動",
    reload: "再読み込み",
    loading: "読み込み中…",
    hiddenOnly: "隠しフォルダのみ（下のチェックボックスで表示）",
    noSubfolders: "サブフォルダなし",
    showHidden: "隠しフォルダを表示",
    selectThisFolder: "このフォルダを選択",
  },
  newTask: {
    title: "新しいタスク",
    descriptionWithParent: (parent: string) =>
      `${parent} から新しいworktreeを分け、セッションを起動してプロンプトを最初の文として送ります。`,
    description:
      "新しいworktreeでセッションを起動し、プロンプトを最初の文として送ります。",
    repository: "リポジトリ",
    taskName: "タスク名",
    prompt: "プロンプト",
    promptPlaceholder: "最初に送る文",
    baseBranch: "ベースブランチ (省略可)",
    parentBranchPlaceholder: "親の今のブランチ",
    defaultBranchPlaceholder: "リポジトリの既定のブランチ",
    starting: "起動中...",
    start: "起動する",
  },
  profile: {
    title: "プロファイル管理",
    description:
      "Claude CLI の設定ディレクトリ (CLAUDE_CONFIG_DIR) をリポジトリ単位で使い分けます。",
    linuxOnly: "Linuxのみ",
    unavailableOnOtherOs: "macOS/Windowsでは利用できません",
    registered: (count: number) => `登録済みプロファイル (${count})`,
    add: "新規追加",
    empty: "プロファイルが未登録です。",
    edit: "編集",
    deleteTitle: "プロファイルを削除しますか？",
    deleteDescription: (name: string) =>
      `「${name}」を削除します。このプロファイルを紐付けたリポジトリは紐付けが解除されます。設定ディレクトリ自体は削除されません。`,
    addTitle: "新規プロファイル追加",
    editTitle: "プロファイル編集",
    name: "名前",
    namePlaceholder: "例: 仕事Max",
    nameHint: "ダッシュボードに表示される名前です",
    configDir: "設定ディレクトリ",
    configDirHint: "設定の保存先。各プロファイルで別ディレクトリにする",
    loginNotice:
      "追加後、このプロファイルを紐付けたリポジトリでセッションを起動すると、 claude CLIが自動でログイン画面を表示します。",
    submitAdd: "追加",
    nameRequired: "名前を入力してください",
    configDirRequired: "設定ディレクトリを入力してください",
    absolutePathRequired: "絶対パス（/ または ~/ で始まる）を指定してください",
  },
  repoSelect: {
    title: "リポジトリを選択",
    descriptionAllowlist:
      "許可されたリポジトリ一覧から選択するか、直接リポジトリパスを入力してください。",
    descriptionScan:
      "スキャンするフォルダを選択するか、直接リポジトリパスを入力してください。",
    scanPath: "スキャンするパス",
    chooseFolder: "フォルダを選択...",
    allowedRepos: (shown: number, total: number) =>
      `許可されたリポジトリ (${shown}/${total})`,
    scanning: "スキャン中...",
    foundReposCount: (shown: number, total: number) =>
      `検出されたリポジトリ (${shown}/${total})`,
    foundRepos: "検出されたリポジトリ",
    searchPlaceholder: "リポジトリを検索...",
    pathInputLabel: "または直接パスを入力",
    select: "選択",
    folderBrowserTitle: "スキャンするフォルダを選択",
    folderBrowserDescription:
      "このフォルダ配下のGitリポジトリをスキャンします。",
  },
  createWorktree: {
    title: "新しいWorktreeを作成",
    description: "新しいブランチでgit worktreeを作成します。",
    branchName: "ブランチ名",
    baseBranch: "ベースブランチ (任意)",
    worktreePath: "Worktreeのパス (自動生成)",
    submit: "Worktreeを作成",
  },
};
