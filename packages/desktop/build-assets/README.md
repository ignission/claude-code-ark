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
