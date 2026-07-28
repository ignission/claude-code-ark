---
name: build-deploy
description: Arkをビルドしてpm2で再起動する
allowed-tools: Bash
---

## 手順

CLAUDE.mdのデプロイ手順に従い、以下を **順番通りに** 実行する。

### 1. 依存関係をインストール

```bash
pnpm install --frozen-lockfile
```

毎日の bump-claude-code ワークフローによる同梱 `@anthropic-ai/claude-code` の更新は、
install で初めて node_modules に反映される。省略すると稼働中の Ark が旧バージョンの
claude を配り続ける。失敗した場合はエラー内容を報告して停止する。

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
- `@anthropic-ai/claude-code` の postinstall（native binary の配置）はルート `package.json` の `pnpm.onlyBuiltDependencies` で許可している。install 後に `claude native binary not installed` が出る場合はこの許可が外れていないか確認する

## pm2 の env 汚染に注意 (pm2 start / --update-env 時)

pm2 は **start 時（および `--update-env` 付き restart 時）の呼び出し元シェルの
環境変数をアプリ env として永続保存し、以後の restart で使い回す**。

このスキルは Claude Code セッション内の Bash から実行されるため、呼び出し元には
セッション由来の `CLAUDE_CONFIG_DIR`（プロファイル）/ `CLAUDECODE` /
`CLAUDE_CODE_ENTRYPOINT` のほか、セッションが持つあらゆる環境変数（秘密情報を
含み得る）が含まれている。これが保存されると、本番 Ark → Ark が fork する
tmux サーバー → 既定プロファイルのセッション、と伝播し、**プロファイル未指定の
セッションが意図しない config dir を使う事故**になる。

- 通常の再起動は上記手順どおり素の `pm2 restart`（保存 env を変更しない）でよい
- **初回の `pm2 start`、`pm2 delete` 後の start、`--update-env` 付き restart は、
  特定変数の除外（denylist）ではなく `env -i` の allowlist 方式で実行する**。
  アプリ設定は `.env.production`（`--node-args="--env-file=..."` 経由）に
  集約されているため、シェル env は HOME / PATH / LANG だけで足りる。
  - 信頼境界の整理: HOME / PATH は「このマシンの実行環境の解決」(mise shims の
    node / pm2 / ~/.pm2) に、LANG は **Ark 配下の ttyd / tmux の UTF-8 処理**
    (落とすと日本語が文字化けする) に必要なため呼び出し元から引き継ぐ。
    この 3 つは秘密情報でも config dir 伝播事故の原因でもない。事故の原因と
    なる `CLAUDE_*` 系を含む**他の全変数は `env -i` が確実に落とす**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager
env -i HOME="$HOME" PATH="$PATH" LANG="${LANG:-en_US.UTF-8}" pm2 start packages/server/dist/cli.js \
  --name claude-code-ark \
  --node-args="--env-file=.env.production" \
  -- --remote
```

- 保存 env が汚染されているかは次で確認する。
  「クリーン」と表示されれば未汚染、JSON が出れば汚染済み、
  「プロセスなし」なら名前か pm2 の状態を疑う（無出力での見落としを防ぐ）:

```bash
pm2 jlist | jq -e '[.[] | select(.name=="claude-code-ark")] | first // error("プロセスなし")
  | .pm2_env.env | {CLAUDE_CONFIG_DIR, CLAUDECODE, CLAUDE_CODE_ENTRYPOINT}
  | with_entries(select(.value != null))
  | if . == {} then "クリーン" else . end'
```

- 汚染時の浄化: `pm2 restart --update-env` は env の**マージ更新**であり、
  保存済みキーの削除を保証しない（オーファン変数が残る:
  [pm2#3486](https://github.com/Unitech/pm2/issues/3486)）。
  確実な浄化は **delete → allowlist 方式のフレッシュ start**:

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager
pm2 delete claude-code-ark
env -i HOME="$HOME" PATH="$PATH" LANG="${LANG:-en_US.UTF-8}" pm2 start packages/server/dist/cli.js \
  --name claude-code-ark \
  --node-args="--env-file=.env.production" \
  -- --remote
pm2 save
```

  実行後、上記の汚染確認コマンドで「クリーン」になったことを必ず検証する
  （`pm2 save` は delete で dump から消えた登録を保存し直すために必要）
