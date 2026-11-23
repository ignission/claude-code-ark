---
name: build-deploy
description: Arkをビルドしてpm2で再起動する
allowed-tools: Bash
---

## 手順

手順の正本は `scripts/deploy.sh` (このスキルのディレクトリ)。ここに書くのは、どのチェックアウトのどのコミットを出すかの判断だけ。

### 1. 配信元のチェックアウトを決める

配信元は `pm2 describe claude-code-ark` のscript pathが属するチェックアウト (exec cwdではない)。

```bash
git -C "$(dirname "$(pm2 jlist | jq -r '.[] | select(.name=="claude-code-ark") | .pm2_env.pm_exec_path')")" rev-parse --show-toplevel
```

### 2. 出すコミットへ切り替える

- 切り替える前に、配信元の `git rev-parse HEAD` を見る。別のPRのコミットを指していたら、別のセッションが確認に出している最中。上書きする前にユーザーに確かめる
- mainを出すなら、`origin/main` の最新に合わせる。PRを確認に出すなら、そのPRのコミットに合わせる

### 3. 配信元のスクリプトを実行する

```bash
<配信元>/.claude/skills/build-deploy/scripts/deploy.sh
```

スクリプトは、install、check、build、再起動、反映の確認までを順に行い、失敗したところで止まる。止まったらエラーの内容を報告する。

- 配信元でないチェックアウトや、未コミットの変更があるチェックアウトからは出さない (スクリプトが止める)
- pm2のデーモンがsystemdのユニット (`pm2-admin.service`) の外にいたら、ユニットから起動し直す。Arkは一度止まるが、tmuxのセッションはpm2の外にいるので残る。`sudo` が要る
- pm2の保存envが汚れていると止まる。`--fresh` を付けて実行し直すと、登録を消して起動し直す

成功すると、同梱claudeのバージョンを出す。それを添えて「ビルド&デプロイ完了」と報告する。
