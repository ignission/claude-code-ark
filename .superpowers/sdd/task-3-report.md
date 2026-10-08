# Task 3 report
- Built lib/file-tabs.ts (pure fns, serialize as {tabs:[{filePath,targetLine,targetEndLine}],activeIndex}; ids regenerated on restore), hooks/useFileTabs.ts, useViewerTabs 7th arg onOpenFile.
- RED: file-tabs.test.ts failed on missing module; useViewerTabs onOpenFile test failed (0 calls). GREEN: 8 files / 80 tests pass. pnpm check exit 0 (only pre-existing warnings).
- Files: lib/file-tabs(.test).ts, hooks/useFileTabs(.test).tsx, hooks/useViewerTabs(.test).ts(x).
- Concerns: tests use createRoot+act (neighbour convention) not testing-library renderHook. Restore does not overwrite tabs opened before restore effect ran.

## Fix round 1
- 保存形を `{ tabs: [{ kind, filePath }], activeFilePath }` に変更。復元は activeFilePath 一致でアクティブを選び、不一致は先頭。不正要素はアクティブに影響しない。行指定は保存も復元もしない。
- 復元と live open の競合: 統合 (保存分 → 未収載の live、activeId は live 維持)。復元反映前 (restoredIds 未登録) とセッション未認識のときは保存せず savedRef にも記録しない。同一 worktree キー共有のコメント追加。storage 例外テストに「タブが開いている」検証を追加。
- 実行: `pnpm vitest run packages/web/src/lib/file-tabs.test.ts packages/web/src/hooks` → 8 files / 85 tests pass。`pnpm check` は自分のファイルに指摘なし (残る 1 error は他エージェント編集中の packages/server/src/index.ts の未使用 import)。
