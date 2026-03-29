# Requirements Document: Multi-Agent Shogun Integration

## Introduction

multi-agent-shogunをclaude-code-arkにフル統合する。現在の独立したworktreeセッション管理に加え、将軍-家老-足軽の階層構造で複数のClaude Codeインスタンスを協調動作させる「将軍モード」を実装する。

これにより、ユーザーは大規模なタスクを効率的に並列処理できるようになる。

## Alignment with Product Vision

claude-code-arkは「複数のClaude Codeインスタンスを効率的に管理するWebUI」を目指している。将軍モードの追加により、単なる並列管理から、**階層的な協調動作**へと機能を拡張する。

## Requirements

### REQ-001: 将軍モードの起動

**User Story:** As a ユーザー, I want WebUIから将軍モードを起動する, so that 複数のClaude Codeエージェントが階層構造で協調動作を開始する

#### Acceptance Criteria

1. WHEN ユーザーが「出陣」ボタンをクリック THEN システム SHALL 将軍(1) + 家老(1) + 足軽(4)のtmuxセッションを起動する
2. WHEN セッション起動完了 THEN システム SHALL 各セッションに対応するinstructions（shogun.md, karo.md, ashigaru.md）を自動送信する
3. WHEN セッション起動中 THEN システム SHALL ローディングインジケーターを表示する
4. IF 起動に失敗した場合 THEN システム SHALL エラーメッセージを表示し、部分的に起動したセッションをクリーンアップする

### REQ-002: 階層構造の可視化

**User Story:** As a ユーザー, I want UIで将軍・家老・足軽の階層を確認する, so that 現在のエージェント構成とステータスを把握できる

#### Acceptance Criteria

1. WHEN 将軍モードが起動中 THEN システム SHALL 将軍ペインを画面上部に表示する
2. WHEN 将軍モードが起動中 THEN システム SHALL 家老ペインを中央に表示する
3. WHEN 将軍モードが起動中 THEN システム SHALL 足軽ペイン(4つ)をグリッドで下部に表示する
4. WHEN 各エージェントのステータスが変化 THEN システム SHALL ステータスインジケーター（待機/作業中/完了）を更新する

### REQ-003: タスクキューの可視化

**User Story:** As a ユーザー, I want queue/内のYAMLファイルの内容を確認する, so that 現在のタスク状況を把握できる

#### Acceptance Criteria

1. WHEN 将軍モードが起動中 THEN システム SHALL shogun_to_karo.yamlの内容をパースして表示する
2. WHEN YAMLファイルが更新された THEN システム SHALL 1秒以内にUIを自動更新する
3. WHEN タスクが足軽に割り当てられた THEN システム SHALL タスクと足軽の紐付けを視覚的に表示する

### REQ-004: ダッシュボード表示

**User Story:** As a ユーザー, I want dashboard.mdの内容をリアルタイムで確認する, so that 全体の進捗を把握できる

#### Acceptance Criteria

1. WHEN 将軍モードが起動中 THEN システム SHALL dashboard.mdをMarkdownとしてレンダリングして表示する
2. WHEN dashboard.mdが更新された THEN システム SHALL 自動的にUIを更新する
3. WHEN 「要対応」セクションが存在 THEN システム SHALL そのセクションをハイライト表示する

### REQ-005: 将軍への指示送信

**User Story:** As a ユーザー, I want UIから将軍に指示を送信する, so that キーボードだけでなくUIからも操作できる

#### Acceptance Criteria

1. WHEN ユーザーが入力フォームにテキストを入力して送信 THEN システム SHALL 将軍ペインにメッセージを送信する
2. WHEN メッセージを送信 THEN システム SHALL 送信履歴を保持する

### REQ-006: 将軍モードの停止

**User Story:** As a ユーザー, I want 将軍モードを停止する, so that リソースを解放できる

#### Acceptance Criteria

1. WHEN ユーザーが「撤退」ボタンをクリック THEN システム SHALL 全てのセッション（将軍、家老、足軽）を停止する
2. WHEN 停止完了 THEN システム SHALL UIを初期状態に戻す

## Non-Functional Requirements

### Code Architecture and Modularity

- **Single Responsibility Principle**: ShogunOrchestratorは将軍モード管理のみ、FileWatcherはファイル監視のみを担当
- **Modular Design**: 既存のTmuxManager, TtydManagerを再利用
- **Dependency Management**: 新規コンポーネントは既存コンポーネントに依存するが、逆方向の依存は作らない
- **Clear Interfaces**: Socket.IOイベントで明確なAPIを定義

### Performance

- 足軽8台同時起動でもUIが重くならない（60fps維持）
- ファイル監視のポーリング間隔は1秒以内

### Security

- 既存のトークン認証を継承
- tmuxセッション名の命名規則でセッション分離を保証

### Reliability

- 部分的な起動失敗時のリカバリー機能
- サーバー再起動後のセッション復元

### Usability

- 既存のworktree単独セッション機能は維持
- 将軍モードはオプション機能として追加

## Out of Scope (v1.0)

- 複数worktreeにまたがる将軍モード
- 足軽の自動スケーリング
- GPUリソースの動的割り当て
- 音声での指示入力
- Spec Workflow連携（別specとして実装予定）

## Confirmed Decisions

| 項目               | 決定         | 理由                                      |
| ------------------ | ------------ | ----------------------------------------- |
| 足軽のデフォルト数 | 4台          | 軽量構成、ほとんどのタスクに十分          |
| ベース技術         | tmux         | 既存実装を活用、安定性重視                |
| UIレイアウト       | 専用タブ追加 | 既存Panesタブとは別に「Shogun」タブを追加 |
