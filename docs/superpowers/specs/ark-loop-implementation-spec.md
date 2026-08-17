# Ark ループエンジニアリング実装 spec

> ステータス: 確定 / Issue #332

## 目的

Manus の context engineering を Ark が起動する1セッション内の認知維持層へ写像し、後続 Issue が実装時に守る契約を固定する。実装対象は `ark/loop/` の配布物と Claude Code adapter に限定する。Issue #332 ではこの Markdown spec と既存 skill からの参照だけを変更し、実行コードは実装しない。

## 対象と非対象

- 対象: 後続 Issue #333〜#336 が実装する `ark/loop/`、XDG runtime、Claude Code adapter。
- 非対象: Ark アプリ本体の `server/`、`client/`、`shared/`、既存 flow の運転仕様、Issue #332 での hook・settings・script 実装。

## Issue 参照表

| Issue | 固定参照 |
| --- | --- |
| #333 | §1, §2, §3, §4-1, §5-1, §5-3, §6-1 |
| #334 | §5-2 |
| #335 | §4-2, §6-3, task.md.tmpl の `{{PREV_FAILURE_SUMMARY}}` |
| #336 | §4-3, §6-2, §7 |

## §1 概要と設計原則

## §2 配置と XDG ディレクトリ契約

## §3 設定・状態・正本

## §4 hook 契約

## §5 テンプレート・ループ規約・アダプタ

## §6 セッションライフサイクル script

## §7 横断知識・flow 接続・足場撤去
