# Ark Homebrew Cask (ひな形)
#
# このファイルは別リポジトリ `<user>/homebrew-tap` の `Casks/ark.rb` の
# ひな形である。実 release では `.github/workflows/release.yml` の
# `update-cask` ジョブが `version` / `sha256` を新リリースの値に置き換える。
#
# 配布チャネル:
#   brew tap <user>/tap
#   brew install --cask ark
#
# 配布前提:
#   - Apple Developer 登録なし (未署名 .app)
#   - arm64 (Apple Silicon) のみサポート
#   - macOS 14 (Sonoma) 以降 (Electron 33 の推奨)
#
# 未署名 .app の Gatekeeper 挙動は F0:B-1 で検証する。Cask の `postflight`
# で `xattr -rd com.apple.quarantine` を実行することで、利用者側の
# "Foo cannot be opened" ダイアログを回避する想定。検証結果次第で
# postflight ブロックは削除する可能性あり (default で剥がれる場合)。
cask "ark" do
  version "0.1.0"
  sha256 "PLACEHOLDER_SHA256_REPLACED_BY_RELEASE_WORKFLOW"

  url "https://github.com/ignission/claude-code-ark/releases/download/v#{version}/Ark-#{version}-arm64.zip"
  name "Ark"
  desc "Local Claude Code session manager"
  homepage "https://github.com/ignission/claude-code-ark"

  # Apple Silicon (arm64) 専用。Intel mac では install を弾く。
  depends_on arch: :arm64
  # Electron 33 の deploymentTarget に合わせ macOS 14 (Sonoma) 以降を要求。
  depends_on macos: ">= :sonoma"

  app "Ark.app"

  # 未署名 .app の quarantine 属性を剥がす。
  # F0:B-1 検証結果次第で:
  #   - Homebrew Cask の default 挙動で quarantine が剥がれるなら postflight 不要
  #   - 剥がれない場合は以下を有効化 (現状は安全のため付与)
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-rd", "com.apple.quarantine", "#{appdir}/Ark.app"],
                   sudo: false
  end

  # `brew uninstall --cask ark` で Ark を実行中なら停止する。
  uninstall quit: "app.ark.local"

  # `brew uninstall --zap --cask ark` で完全削除する際の対象。
  # 通常 uninstall ではデータは残る (再 install で復元可能)。
  zap trash: [
    "~/Library/Application Support/Ark",
    "~/Library/Logs/Ark",
    "~/Library/Preferences/app.ark.local.plist",
    "~/Library/Saved Application State/app.ark.local.savedState",
    "~/Library/Caches/app.ark.local",
  ]
end
