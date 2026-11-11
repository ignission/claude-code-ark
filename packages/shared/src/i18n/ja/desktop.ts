export const desktop = {
  /** 同梱の Claude CLI が見つからないときのエラーダイアログ */
  bundledClaudeMissing: {
    title: "Ark: bundled Claude CLI が見つかりません",
    body: (paths: string) =>
      `配布物の取り込み漏れが疑われます。Ark.app の再インストールをお試しください。\n\n参照パス:\n${paths}\n\n詳細はログを確認してください。`,
  },
};
