---
name: metrics
description: ハーネスエンジニアリングの効果メトリクスを収集・報告する
allowed-tools: Bash
---

## 概要

過去N日間のPR数・CI失敗率・CodeRabbit指摘数・手戻り率を収集し、テーブル形式で報告する。

## 手順

1. メトリクス収集スクリプトを実行する（デフォルト: 過去30日）

```bash
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/metrics.sh" 30
```

2. 結果をテーブル形式でユーザーに報告する

| メトリクス | 値 | 傾向 |
|-----------|---|------|
| マージ済みPR | N件 | - |
| CI失敗率 | N% | - |
| CodeRabbit指摘 | N件/PR | - |
| revert/fixコミット | N件 | - |
