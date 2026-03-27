---
paths:
  - "server/**"
  - "shared/**"
---

# バックエンドテストルール

## テストフレームワーク

- **vitest** を使用
- テストファイルは `*.test.ts` / `*.spec.ts`
- 実行: `pnpm vitest` または `pnpm vitest run`

## テスト方針

### ユニットテスト
- `server/lib/` 配下の各マネージャーを個別にテスト
- 外部プロセス（tmux, ttyd, cloudflared）の呼び出しはモック化
- `child_process.execSync` / `spawnSync` を `vi.mock` でスタブ

### 統合テスト
- Socket.IOイベントのE2Eフロー
- Express APIエンドポイントのテスト（supertest推奨）

## 型チェック

- `pnpm check` (`tsc --noEmit`) で型エラーがないことを確認
- テスト実行前に型チェックを通すこと
