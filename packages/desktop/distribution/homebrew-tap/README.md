# homebrew-tap (ひな形)

このディレクトリは、別リポジトリ `<user>/homebrew-tap` のひな形である。
本リポジトリ (`ignission/claude-code-ark`) には Cask DSL の構文確認・version
履歴管理のためにコピーを置いている。実 release では本ファイルが
`<user>/homebrew-tap/Casks/ark.rb` に同期される。

## ディレクトリ構造

```
homebrew-tap/                     ← この階層を別 repo として切り出す
├── Casks/
│   └── ark.rb                    ← Ark の Cask 定義
└── README.md                     ← 利用者向け install ガイド
```

## セットアップ手順 (リポジトリオーナー側)

### 1. 別リポジトリ `homebrew-tap` を作成

GitHub で `<user>/homebrew-tap` リポジトリを作成する。命名規則:

- リポジトリ名は **必ず `homebrew-tap`** にする (Homebrew の規約)
- `brew tap <user>/<name>` の `<name>` 部分はリポジトリ名から `homebrew-` を除いた
  もの (`homebrew-tap` → `tap`)

### 2. Caskfile を配置

このディレクトリの `Casks/ark.rb` を `<user>/homebrew-tap/Casks/ark.rb` にコピー
してコミットする。`version` と `sha256` は初回 release 後に
`.github/workflows/release.yml` の `update-cask` ジョブが自動更新する。

### 3. GitHub Token を設定

`.github/workflows/release.yml` の `update-cask` ジョブが `homebrew-tap` に
push するためのトークンを Ark 本体リポジトリの secrets に登録する:

- secret 名: `HOMEBREW_TAP_TOKEN`
- 権限: `repo` (homebrew-tap に push できる権限)
- 生成方法: GitHub Personal Access Token (classic) または fine-grained PAT
  (`contents: write` を `<user>/homebrew-tap` に対して付与)

`dawidd6/action-homebrew-bump-formula` を使う場合の例 (release.yml の
update-cask ジョブで利用):

```yaml
- uses: dawidd6/action-homebrew-bump-formula@v4
  with:
    token: ${{ secrets.HOMEBREW_TAP_TOKEN }}
    tap: <user>/homebrew-tap
    formula: ark
    tag: ${{ github.ref_name }}
```

## 利用者向け install コマンド

```bash
# 1. tap を追加
brew tap <user>/tap

# 2. Ark を install
brew install --cask ark

# 起動: Finder → Applications → Ark.app
# または:
open -a Ark
```

### アンインストール

```bash
# 通常 uninstall (.app のみ削除、データは保持)
brew uninstall --cask ark

# 完全削除 (データを含めて全て削除)
brew uninstall --zap --cask ark
```

### アップデート

```bash
brew upgrade --cask ark
```

## F0:B-1 検証結果での postflight 要否

`Casks/ark.rb` の `postflight` ブロック (xattr -rd com.apple.quarantine) は、
F0:B-1「Homebrew Cask + 未署名 .app の Gatekeeper 挙動検証」の結果次第で
要否が決まる。

| F0:B-1 検証結果 | postflight ブロック |
|---|---|
| `brew install --cask` の default 挙動で quarantine が剥がれる | 削除して OK |
| quarantine が残り、初回起動時に Gatekeeper 警告が出る | 必須 (現状はこちらを前提) |
| Cask 経由でも警告が出る (postflight でも不十分) | 配布チャネル見直し (フェーズ 7 全体の再設計) |

検証結果は `plans/macos-app-blocker-validation.md` に記録される予定。

## 関連ファイル

- `packages/desktop/electron-builder.yml` — `.app` の build 設定
- `.github/workflows/release.yml` — tag push で `.app` を build し Releases に upload + Cask を更新
- `.github/workflows/build-bin.yml` — tmux/ttyd のクロスビルド (F4)

## 参考

- [Homebrew Cask Cookbook](https://docs.brew.sh/Cask-Cookbook)
- [Acceptable Casks](https://docs.brew.sh/Acceptable-Casks) — 公式 homebrew-cask に
  PR せず自前 tap で配布する場合の慣習
- [dawidd6/action-homebrew-bump-formula](https://github.com/dawidd6/action-homebrew-bump-formula)
