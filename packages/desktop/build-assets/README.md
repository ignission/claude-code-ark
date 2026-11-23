# build-assets/

Ark Desktop (Electron) の配布アイコン / Tray アイコンを置くディレクトリ。

## 現状 (Phase 3 placeholder)

| ファイル              | 用途                                | 状態                                  |
| --------------------- | ----------------------------------- | ------------------------------------- |
| `tray-icon.png`       | Tray (menubar) アイコン 1x         | 1x1 透明 PNG placeholder              |
| `tray-icon@2x.png`    | Tray (menubar) アイコン 2x         | 1x1 透明 PNG placeholder              |
| `icon.icns`           | macOS `.app` アイコン (Dock / Finder) | 空ファイル placeholder (F4 で正式版に) |

## 解決経路

- `packages/desktop/src/tray.ts:resolveTrayIconPath()` が
  - packaged: `process.resourcesPath/build-assets/tray-icon.png`
  - unpackaged: `<repo>/packages/desktop/build-assets/tray-icon.png`
  の順で existsSync チェックする。欠落・空でも `nativeImage.createEmpty()` に
  フォールバックして起動はクラッシュしない。

## F4 残課題

- 正式 `icon.icns` (macOS) を `iconutil` で生成し本ファイルを置き換える
- Tray の Template Image (黒のみ + suffix `Template`) 仕様で再描き出し
- `electron-builder.yml` の `mac.icon: build-assets/icon.icns` を有効化
- `extraResources` に `build-assets/tray-icon*.png` を追加して .app に同梱

## F5 (Claude CLI 自動インストール) 同梱物

| ファイル                       | 用途                                           | 状態     |
| ------------------------------ | ---------------------------------------------- | -------- |
| `node/bin/node`                | Claude CLI 取得用の同梱 Node.js (arm64)         | 未配置   |
| `node/lib/node_modules/npm/**` | 同梱 Node に bundled な npm CLI                | 未配置   |

### 配置経路

- `packages/desktop/src/claude-installer.ts:resolveBundledNodePath()` が
  packaged 時に `<process.resourcesPath>/bin/node` を参照する。
- 続けて `resolveBundledNpmCliPath()` が
  `<process.resourcesPath>/bin/lib/node_modules/npm/bin/npm-cli.js` を参照する。
  ※ Node.js 公式 distribution の tarball 構造（`bin/` と `lib/` が同階層）に
     合わせており、`extraResources: { from: build-assets/node, to: bin }` で
     ディレクトリごと `Resources/bin/` に展開する想定。
- 同梱 Node が見つからない場合 (skeleton 状態) は `node-missing` イベントを発火し、
  server 側 `system.ts:resolveClaudePath()` の system claude フォールバックに任せる。

### F5 残課題（F5-followup）

- F0:B-2 で `node-v<X>-darwin-arm64.tar.gz` 同梱の方針確定
- CI (`build-bin.yml` or 新規 `build-node.yml`) で Node distribution を
  `build-assets/node/` に展開して artifact 化
- `electron-builder.yml` の `extraResources: build-assets/node` を有効化
- 進捗 IPC bridge (`packages/web/src/components/ClaudeInstallProgressDialog.tsx`
  に実状態を配信) の実装
- 失敗時のリトライ UI / 手動 install 案内
