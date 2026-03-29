# CCM → Ark 移行計画

## 現状

### 稼働中のインスタンス
- **PM2プロセス**: `claude-code-manager`（PID 1512493, online）
- **tmuxセッション**: 4件（`ccm-7u6xDXMy`, `ccm-89LMpidJ`, `ccm-aohoaEXz`, `ccm-lFJDpiEO`）
- **ttydプロセス**: 4件（ポート 7680, 7682, 7684, 7685）
- **Cloudflare tunnel**: `ccm-vm-tunnel`（UUID: 2cef0a4b）→ **名前は維持**
- **tmpファイル**: `/tmp/ccm-images/`（4セッション分）、`/tmp/ccm-screenshot.png`
- **.env.production**: 既にARK_プレフィックスに更新済み（`ARK_TUNNEL_NAME=ark-vm-tunnel`）

### コード変更（PR #47）
- 全ファイルでリネーム済み、CI/CodeRabbit通過済み
- マージ待ち

---

## Phase 1: PR #47 マージ前の準備

### 1-1. .env.production のtunnel名修正
tunnel名は `ccm-vm-tunnel` を維持するため、`.env.production` を修正:
```dotenv
ARK_TUNNEL_NAME=ccm-vm-tunnel  ← ark-vm-tunnel から変更
```

### 1-2. prettier → biome 移行（別PR）
PR #47とは別ブランチで実施:
1. `pnpm add -D @biomejs/biome` でbiome導入
2. `pnpm biome init` で `biome.json` 生成
3. `.prettierrc` の設定を `biome.json` に移植
   - semi: true, trailingComma: "es5" → biome相当設定
   - singleQuote: false, printWidth: 80, tabWidth: 2
   - arrowParens: "avoid" → biome: `arrowParentheses: "asNeeded"`
4. `pnpm biome check --write .` で全ファイルフォーマット
5. `.prettierrc`, `.prettierignore` 削除
6. `pnpm remove prettier`
7. `package.json` のscripts更新:
   - `"format": "biome check --write ."`
   - `"lint": "biome lint ."`
   - `"check": "biome check . && tsc --noEmit"`
8. `.prettierignore` の除外設定を `biome.json` の `files.ignore` に移植

---

## Phase 2: デプロイ（PR #47 マージ後）

### 2-1. 稼働中インスタンスの停止
```bash
# 1. ttydプロセスをkill（ポート解放）
pkill -f ttyd

# 2. 旧PM2プロセスを削除
pm2 delete claude-code-manager
```

### 2-2. コードの更新・ビルド
```bash
# 3. mainを最新化
git pull origin main

# 4. 依存関係の更新
pnpm install

# 5. ビルド
pnpm build
```

### 2-3. 新PM2プロセスで起動
```bash
# 6. 新しいアプリ名 claude-code-ark で起動
pm2 start ecosystem.config.cjs

# 7. PM2保存
pm2 save
```

### 2-4. 起動後の確認
サーバー起動時に `SessionOrchestrator` が自動で以下を実行:
- 既存tmuxセッション（**`ark-` プレフィックス**）を検出 → **旧 `ccm-` セッションは検出されない**
- SQLiteのセッション情報と照合して復元

**旧tmuxセッションの扱い**:
- `ccm-*` セッションは新コードで検出不能になる
- 稼働中のClaude Codeインスタンスがあれば、手動で完了を確認後に削除:
  ```bash
  # 旧セッション一覧確認
  tmux list-sessions | grep ccm-

  # 不要なら削除
  tmux kill-session -t ccm-7u6xDXMy
  tmux kill-session -t ccm-89LMpidJ
  tmux kill-session -t ccm-aohoaEXz
  tmux kill-session -t ccm-lFJDpiEO
  ```
- または一括: `tmux kill-server`（全セッション破棄、再起動後に新規作成）

### 2-5. tmpファイルのクリーンアップ
```bash
# 旧tmpファイル削除（任意）
rm -rf /tmp/ccm-images /tmp/ccm-screenshot.png /tmp/ccm-tunnel-state.json
```

---

## Phase 3: 動作確認

### 3-1. 基本動作
- [ ] ブラウザで `http://localhost:3001` にアクセス → タイトルが「Ark」
- [ ] セッション新規作成 → tmuxセッション名が `ark-*` プレフィックス
- [ ] ttydターミナルが正常表示
- [ ] メッセージ送信（send-keys）が動作

### 3-2. リモートアクセス
- [ ] Cloudflare tunnel経由（`ccm.ignission.tech`）でアクセス可能
- [ ] トークン認証が正常動作

### 3-3. Beacon
- [ ] MCPツール名が `mcp__ark-beacon__*` で正しく動作
- [ ] Beacon判断コマンドが動作

---

## 実行順序まとめ

| # | フェーズ | 内容 | 備考 |
|---|---------|------|------|
| 1 | Phase 1-1 | `.env.production` tunnel名修正 | PR #47に追加コミット |
| 2 | Phase 1-2 | prettier → biome 移行 | **別PR** |
| 3 | PR #47マージ | コードリネーム反映 | biome PRの後でもOK |
| 4 | Phase 2-1 | ttyd/PM2停止 | ダウンタイム開始 |
| 5 | Phase 2-2 | pull, build | |
| 6 | Phase 2-3 | 新PM2起動 | ダウンタイム終了 |
| 7 | Phase 2-4 | 旧tmuxセッション確認・削除 | 手動判断 |
| 8 | Phase 2-5 | tmpクリーンアップ | 任意 |
| 9 | Phase 3 | 動作確認 | |

**想定ダウンタイム**: Phase 2-1 〜 2-3（約2-3分）
