# Beacon 再設計: 三役分離と運転層 LoopManager の導入

日付: 2026-07-16
状態: 設計承認済み（ユーザーレビュー待ち）

## 背景と動機

現行 Beacon は単一の常駐対話 claude（tmux `ark-beacon`）が **俯瞰・判断・運転** の三役を担う。
進捗確認や「判断」フローは LLM が `get_session_output`（画面読み）で状態を推測するため確率的で、
バックログを自動で回す仕組み（loop engineering）も存在しない。

外部事例の分析から以下を輸入する:

- **takt** (nrslib): 「エージェントは信頼せず外部から制御する」— 決定論をエンジン側に置く思想。
  ただし takt 自体は導入しない（人間ゲートが同期的・deploy まで閉じない・fleet 運転がない）
- **flow-loop** (別リポジトリの PR): 冪等 tick の reconciler パターン・非同期人間ゲート・
  WIP 上限/ブレーカー/kill switch 等の安全装置。ただしゲートの置き場は PR 上ではなく Ark UI に変更
  （epoch 鮮度判定の複雑さが構造的に消える）
- **agmsg**: 導入しない。搬送路と人間ゲートは Ark 自身の UI・SQLite・PushNotification で賄う

## 確定した設計判断（ユーザー承認済み）

| 論点 | 決定 |
|---|---|
| 解きたい課題 | 俯瞰・前進判断の信頼性 + 自動運転化（loop engineering） |
| 会話層/運転層 | 分離。運転は決定論的 reconciler（TypeScript）、Beacon は人間の窓口 |
| 実行エンジン | Ark 汎用パイプライン（セッション内工程は各 repo の CLAUDE.md/スキルに委任） |
| 人間ゲート | Ark UI 承認カード + PushNotification。**設計承認 + マージ確認の2ゲート** |
| pick ソース (v1) | Ark 内キュー（SQLite）。Jira/GitHub Issues は将来拡張 |
| パイプライン終点 (v1) | マージ + worktree cleanup まで。デプロイ監視は将来拡張 |
| 実装形態 | 案A: サーバー内蔵 LoopManager（別プロセス案・Beacon LLM tick 案は棄却） |

## アーキテクチャ: 三役分離

```
運転層  LoopManager（server 内蔵・決定論的 reconciler・リポジトリ単位）
        pick → worktree → セッション起動 → plan ゲート → 実装 → PR/CI 監視 → マージゲート → merge + cleanup
会話層  Beacon（常駐対話 claude・現行のまま・役割を「窓口」に縮小）
        壁打ち → queue_task でキュー投入 / loop_status で俯瞰の語り部 / アドホックなセッション操作
UI 層   承認カード（plan / merge）+ キュー管理 + run ダッシュボード + PushNotification
```

LLM は運転判断に一切関与しない。シグナル源は3つだけ（すべて決定論的）:

1. **セッション状態**: 既存 bridgeStatus（busy / AWAITING / idle）。capture-pane は existence チェックのみ
   という既存原則（チャット UI v3 の情報源分離）を維持
2. **会話内容**: JSONL transcript。plan ゲートカードに表示する plan 本文は JSONL の最終 assistant
   メッセージから取得
3. **外部状態**: gh CLI（PR 検知・CI checks・merge 実行）

## コンポーネント

### `server/lib/loop-manager.ts`（新規）

- 既存 EventEmitter マネージャーパターンに従うシングルトン。SessionOrchestrator と同格
- tick: `setInterval`（30〜60秒）+ イベント駆動の即時前進（bridgeStatus 変化・承認操作）
- **tick は何も待たない**（冪等・毎回状態突き合わせ）。**重い前進は 1 tick 1 run**
  （重い前進 = pick と修正差し戻しなどセッション起動/send-keys を伴う遷移。ゲートカード発行・merge 等の軽い前進は複数 run 処理してよい）
- run 単位の in-memory in-flight ロックで tick とイベント駆動の再入を防ぐ

### SQLite 新テーブル（database.ts）

- `loop_tasks`: キュー（repoPath, title, body, priority, status: queued/running/done/aborted/error）
- `loop_runs`: run 状態機械（taskId, phase, gate, worktreeId, sessionId, branch, prNumber,
  iter, lastSignalAt, haltReason）
- `loop_repo_config`: リポジトリ単位設定（repoPath, enabled/paused, wip_limit 既定1,
  merge_method 既定 squash, consecutive_halts）

### Socket.IO イベント（shared/types.ts に型追加）

- S→C: `loop:gate`（承認カード）、`loop:run-updated`、`loop:queue-updated`
- C→S: `loop:approve`（承認 / 修正指示テキスト / 中止）、`loop:queue-add`、`loop:pause` / `loop:resume`

### ark-beacon MCP 追加ツール（ark-mcp-server.ts）

`queue_task` / `list_loop_runs` / `pause_loop` / `resume_loop`。
C-B1 により反映には Beacon の一度きりの再起動が必要（既知の制約どおり）。

### UI（web）

- LoopGateCard: AUQ カードと同系の承認カード（承認 / 修正指示の自由入力 / 中止）
- キュー管理・run ダッシュボード（SessionDashboard への統合を想定）
- 新規 park（ゲート発行）・halt・ブレーカー発動時のみ PushNotification（スパム防止）

## run の状態機械

```
queued → planning → [plan-gate] → implementing → ci-watch → [merge-gate] → done
                ↑修正指示(iter≤3)↲           ↑CI失敗/修正指示(iter≤3)↲
どのフェーズからも → halted（理由付き）/ aborted
```

| フェーズ | 前進シグナル | アクション |
|---|---|---|
| `queued` | アクティブ run 数 < wip_limit | worktree 作成（`loop/<taskId>-<slug>`）→ セッション起動 → タスク +「まず plan を提示して停止。実装開始禁止」を送信 |
| `planning` | bridgeStatus idle（2 tick 連続で誤検知回避） | JSONL 最終 assistant メッセージを plan として承認カード発行 + 通知 |
| `plan-gate` | UI の承認/修正/中止 | 承認→「実装を進め PR を作成せよ」送信。修正→指示文を send-keys、iter++（>3 で halt） |
| `implementing` | `gh pr list --head <branch>` で PR 検知 | `ci-watch` へ。idle なのに PR なしが続く場合は1回だけ督促 → それでも無ければ halt |
| `ci-watch` | `gh pr checks` 全 green | マージ承認カード発行（PR URL・diff 統計）。check 失敗 → 失敗サマリをセッションへ送信し再 push を待つ（iter≤3） |
| `merge-gate` | UI の承認/修正/中止 | 承認→ `gh pr merge --squash`（merge_method 設定に従う）→ セッション停止 → worktree 削除 → `done`。修正→セッションへ送信し `ci-watch` へ戻る |

## エラー処理と安全装置

- **tmux セッション消滅** → `halted(session-lost)` + 通知
- **gh 失敗** → 次 tick リトライ、3連続で `halted(gh-error)`
- **AWAITING（権限プロンプト等）** → 既存 AWAITING バナーに任せ、run は遷移しない。30分継続で注意通知のみ
- **サーバー再起動** → 起動時 reconcile: 非終端 run の worktree/tmux/PR 実在確認 → tick 再開。
  状態はすべて SQLite（/tmp 消失リスクなし）
- **ブレーカー** → リポジトリ単位で連続 halt 3 → ループ自動 pause + 通知。前進があればカウンタリセット
- **kill switch** → `pause_loop`（UI ボタン / Beacon ツールの両方から）
- **中止（abort）** → セッション停止 + worktree は残置（削除は人間判断。既存運用と同じ）
- **遷移の冪等性** → 遷移は SQLite 上の現 phase を条件にガード。同一シグナル2回で遷移は1回

## 既存 Beacon への影響

- システムプロンプトの「タスク着手」フロー → 壁打ち後 `queue_task` 投入に書き換え
  （worktree 直作成・send_to_session 直指示は廃止。アドホック操作用に既存ツールは残す）
- 「進捗確認」→ `list_loop_runs` を第一情報源に変更。loop 管理外のセッションのみ従来の画面読み
- loop 管理セッションと手動起動セッションは共存する。LoopManager は自分が起動した run のみ管理する

## テスト方針

- vitest。gh/tmux/bridgeStatus をモック、DB は in-memory SQLite
- 状態機械の全遷移表 + 冪等性（同一シグナル2回 → 遷移1回）+ iter 上限 + ブレーカー + 再起動 reconcile
- `pnpm check`（tsc --noEmit）必須。esbuild は型チェックしない教訓を踏襲

## スコープ外（将来拡張）

- pick ソースの Jira（JQL）/ GitHub Issues 対応
- デプロイ監視フェーズ（P12 相当）
- CodeRabbit スレッド検知の一次シグナル化（v1 は CI checks のみ）
- エンジンの複数化（claude 以外）・人間待ち vs 機械時間のリードタイムメトリクス
