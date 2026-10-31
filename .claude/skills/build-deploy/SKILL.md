---
name: build-deploy
description: Arkをビルドしてpm2で再起動する
allowed-tools: Bash
---

## 手順

mainをpullしたあと、以下を **順番通りに** 実行する。デプロイ手順の正本はこのファイル。

### 1. 依存関係をインストール

```bash
pnpm install --frozen-lockfile
```

毎日の bump-claude-code ワークフローによる同梱 `@anthropic-ai/claude-code` の更新は、
install で初めて node_modules に反映される。省略すると稼働中の Ark が旧バージョンの
claude を配り続ける。失敗した場合はエラー内容を報告して停止する。

`.mise.toml` と `packageManager` が指す版の pnpm が要る。mise が古いと
`no asset found: pnpm-linux-arm64` で pnpm 自体が入らず、この手順が失敗する。
その場合は `mise self-update` するか、corepack 経由に切り替える:

```bash
corepack pnpm install --frozen-lockfile
```

### 2. ビルド

```bash
pnpm build
```

失敗した場合はエラー内容を報告して停止する。

### 3. ttydプロセスをkill（再起動の直前に実行）

```bash
pkill -x ttyd
```

エラーは無視してよい（ttydが起動していない場合）。

### 4. pm2で再起動

```bash
pm2 restart claude-code-ark
```

### 5. 反映確認と結果報告

```bash
packages/server/node_modules/.bin/claude --version
```

- 成功: 同梱 claude のバージョンを添えて「ビルド&デプロイ完了」と報告
- 失敗: エラー内容を表示

## 注意

- `pkill -x ttyd` を省略するとttydのポート(7680〜)が競合し、ターミナルが表示されなくなる。kill は pm2 restart の直前に行う（`-f` はコマンドライン文字列に "ttyd" を含む無関係なプロセスへ誤マッチしうるため `-x` を使う）
- コマンドは必ず上記の順番で実行すること
- `@anthropic-ai/claude-code` の postinstall（native binary の配置）は `pnpm-workspace.yaml` の `allowBuilds` で許可している。install 後に `claude native binary not installed` が出る場合はこの許可が外れていないか確認する
