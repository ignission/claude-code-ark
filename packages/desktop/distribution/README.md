# Ark Desktop 配布 (Distribution)

このディレクトリは Ark の .app 配布に関するリソースを集約する。

## ディレクトリ構造

```
distribution/
├── README.md                          ← このファイル
└── homebrew-tap/                      ← 別 repo `<user>/homebrew-tap` のひな形
    ├── README.md                      ← tap セットアップ手順
    └── Casks/
        └── ark.rb                     ← Ark の Cask 定義
```

## 配布チャネル

### Homebrew Cask (推奨)

```bash
brew tap <user>/tap
brew install --cask ark
```

`<user>` 部分は `homebrew-tap` リポジトリを所有する GitHub user/org に置換する
(例: `brew tap ignission/tap`)。

### GitHub Releases 直 DL (代替)

[Releases](https://github.com/ignission/claude-code-ark/releases) から
`Ark-X.Y.Z-arm64.zip` をダウンロードして `Applications/` に配置する。

未署名 .app のため、初回起動時に Gatekeeper の警告が出る可能性がある。
警告を回避する場合は手動で quarantine 属性を剥がす:

```bash
xattr -rd com.apple.quarantine /Applications/Ark.app
```

## サポート環境

| 項目 | 要件 |
|---|---|
| OS | macOS 14 (Sonoma) 以降 |
| アーキテクチャ | arm64 (Apple Silicon) のみ |
| 署名 | 未署名 (Apple Developer 登録なし) |
| Notarization | なし |

Intel mac はサポート対象外 (`depends_on arch: :arm64` で install を弾く)。

## リリースフロー

`.github/workflows/release.yml` が tag push (`v*.*.*`) をトリガーに以下を実施:

1. macos-14 (Apple Silicon) runner で `.app` を build
2. `electron-builder --mac --arm64 zip` で `Ark-X.Y.Z-arm64.zip` を生成
3. SHA256 を計算
4. GitHub Releases に zip を upload
5. 別 repo `<user>/homebrew-tap` の `Casks/ark.rb` の `version` / `sha256` を更新
   (要 `HOMEBREW_TAP_TOKEN` secret)

実 release tag は F4 (tmux/ttyd 同梱) / F5 (Claude CLI loader) / F6 (Keychain プロファイル)
完了後に打つ想定。それまでは `workflow_dispatch` で動作確認のみ。

## 関連ドキュメント

- `homebrew-tap/README.md` — 別 repo `homebrew-tap` のセットアップ手順
- `packages/desktop/electron-builder.yml` — `.app` の build 設定
- `plans/macos-app-implementation-plan.md` フェーズ 7 — Homebrew 自前 tap の設計
