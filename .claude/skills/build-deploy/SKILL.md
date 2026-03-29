---
name: build-deploy
description: Arkをビルドしてpm2で再起動する
allowed-tools: Bash
---

## 手順

CLAUDE.mdのデプロイ手順に従い、以下を **順番通りに** 実行する。

### 1. ttydプロセスをkill

```bash
pkill -f ttyd
```

エラーは無視してよい（ttydが起動していない場合）。

### 2. ビルド

```bash
pnpm build
```

失敗した場合はエラー内容を報告して停止する。

### 3. pm2で再起動

```bash
pm2 restart claude-code-ark
```

### 4. 結果報告

- 成功: 「ビルド&デプロイ完了」と報告
- 失敗: エラー内容を表示

## 注意

- `pkill -f ttyd` を省略するとttydのポート(7680〜)が競合し、ターミナルが表示されなくなる
- 3つのコマンドは必ず上記の順番で実行すること
