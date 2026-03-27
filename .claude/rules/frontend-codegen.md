---
paths:
  - "client/**"
---

# フロントエンド開発ルール

## 技術スタック

- **React 19** + **TailwindCSS 4** + **shadcn/ui**
- ビルド: **Vite**
- ルーティング: **wouter**
- リアルタイム通信: **Socket.IO client**（`useSocket.ts`）

## コンポーネント設計

- UIコンポーネントは `client/src/components/` に配置
- shadcn/uiベースのコンポーネントは `client/src/components/ui/` に配置
- ページコンポーネントは `client/src/pages/` に配置
- カスタムフックは `client/src/hooks/` に配置

## モバイル対応

- `useIsMobile()` フックでモバイル判定
- モバイル用コンポーネント（`MobileLayout`, `MobileSessionView`）とPC用（`MultiPaneLayout`）を分離
- `useVisualViewport()` でソフトウェアキーボード対応
- `useComposition()` でIME入力対応

## Socket.IO通信

- 全Socket.IOイベントは `useSocket.ts` に集約
- イベント型定義は `shared/types.ts` の `ServerToClientEvents` / `ClientToServerEvents` を参照
- 新しいイベントを追加する場合は `shared/types.ts` の型定義も更新すること

## 注意事項

- iframeの再マウントを避けること（display: none/blockで切り替え）
- ttyd iframeのURLはローカル/リモートで構築方法が異なる（`TerminalPane.tsx` 参照）
