# Ark - TODO

## 🚨 最優先: 会話継続の実装

TypeScript SDK V2 インターフェースを使用して会話継続を実装する。

### 実装手順

- [ ] `server/lib/claude.ts` を V2 API に書き換え
  - `unstable_v2_createSession()` でセッション作成
  - `session.send()` でメッセージ送信
  - `session.stream()` でレスポンス受信
  - `session.close()` でクリーンアップ

- [ ] セッションIDの保存と再開機能
  - `msg.session_id` を保存
  - `unstable_v2_resumeSession(sessionId)` で再開

- [ ] エラーハンドリングの追加

### 参考ドキュメント

https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview

## 高優先度

- [ ] **メッセージ表示の修正**: ユーザーメッセージがChatPaneに表示されない問題を修正
  - `client/src/hooks/useSocket.ts`のステート管理を確認
  - `client/src/components/ChatPane.tsx`のprops受け渡しを確認
  - Reactの再レンダリングトリガー

## 中優先度

- [ ] **マルチペインビュー**: 複数セッションを同時に表示
  - `react-resizable-panels`を使用
  - 各ペインに独立したChatPaneを配置

- [ ] **エラーハンドリング改善**: Claude CLIのエラーをユーザーフレンドリーに表示

## 低優先度

- [ ] **セッション履歴の永続化**: ブラウザリロード後も履歴を保持
- [ ] **設定画面**: Claude CLIのオプションをUIから設定
- [ ] **テーマカスタマイズ**: ユーザーがカラースキームを変更可能に

## 完了

- [x] Git Worktree管理（一覧、作成、削除）
- [x] セッション管理（起動、停止）
- [x] チャットUI基本実装
- [x] Socket.IOによるリアルタイム通信
- [x] Claude Agent SDK統合（基本）
- [x] Terminal-Inspired Dark Modeデザイン
