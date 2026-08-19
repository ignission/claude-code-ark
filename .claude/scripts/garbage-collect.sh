#!/bin/bash
# 孤立ファイル・未使用コード検出スクリプト
# 決定論的ルールで検出し、削除判断は人間が行う

PROJECT_ROOT="${1:-$(pwd)}"

# プロジェクトルートのバリデーション
if [ ! -d "$PROJECT_ROOT/packages/server/src" ] && [ ! -d "$PROJECT_ROOT/packages/web/src" ]; then
  echo "ERROR: $PROJECT_ROOT はプロジェクトルートではありません" >&2
  exit 1
fi

FOUND=0

echo "=== 孤立TypeScript/JavaScriptファイル検出 ==="
echo "他ファイルからimportされていない.ts/.tsx/.js/.jsxファイルを検出"
echo ""

# packages/server/src/lib/
if [ -d "$PROJECT_ROOT/packages/server/src/lib" ]; then
  while IFS= read -r f; do
    basename=$(basename "$f" | sed 's/\.\(ts\|tsx\|js\|jsx\)$//')
    # index.ts はスキップ
    [[ "$basename" == "index" ]] && continue
    # このファイル以外から参照されているか
    refs=$(grep -rlE "(from.*['\"].*/${basename}['\"]|import.*['\"].*/${basename})" "$PROJECT_ROOT/packages/server/src" --include='*.ts' --include='*.tsx' --include='*.js' 2>/dev/null | grep -v "$f" | head -1)
    if [ -z "$refs" ]; then
      echo "  孤立候補 (server): $f"
      FOUND=$((FOUND + 1))
    fi
  done < <(find "$PROJECT_ROOT/packages/server/src/lib" \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \) \
    -not -name 'index.ts' -not -name 'index.js' \
    -not -path '*/tests/*' -not -path '*/test/*' -not -path '*/__tests__/*' \
    -not -path '*/node_modules/*' 2>/dev/null)
fi

echo ""
echo "=== 孤立フロントエンドコンポーネント検出 ==="
echo "他ファイルからimportされていない.tsx/.tsファイルを検出"
echo ""

# packages/web/src/
if [ -d "$PROJECT_ROOT/packages/web/src" ]; then
  while IFS= read -r f; do
    basename=$(basename "$f" | sed 's/\.\(ts\|tsx\|js\|jsx\)$//')
    # エントリポイントはスキップ
    [[ "$basename" == "App" || "$basename" == "main" || "$basename" == "index" ]] && continue
    # このファイル以外から参照されているか
    refs=$(grep -rlE "(from.*['\"].*/${basename}['\"]|import.*['\"].*/${basename})" "$PROJECT_ROOT/packages/web/src" --include='*.tsx' --include='*.ts' --include='*.js' 2>/dev/null | grep -v "$f" | head -1)
    if [ -z "$refs" ]; then
      echo "  孤立候補 (web): $f"
      FOUND=$((FOUND + 1))
    fi
  done < <(find "$PROJECT_ROOT/packages/web/src" \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \) \
    -not -name 'App.tsx' -not -name 'main.tsx' -not -name 'index.tsx' -not -name 'index.ts' \
    -not -path '*/node_modules/*' 2>/dev/null)
fi

echo ""
echo "=== コード重複検出（jscpd） ==="
echo "10行以上・70トークン以上の重複を検出（テストコード除外）"
echo ""

DUPES=0

# server
if [ -d "$PROJECT_ROOT/packages/server/src/lib" ]; then
  echo "--- server ---"
  JSCPD_SERVER_TMPDIR=$(mktemp -d)
  npx jscpd "$PROJECT_ROOT/packages/server/src/lib" --min-lines 10 --min-tokens 70 \
    --ignore "**/tests/**,**/*test*,**/*spec*" --reporters json --output "$JSCPD_SERVER_TMPDIR" >/dev/null 2>&1 || true
  if [ -f "$JSCPD_SERVER_TMPDIR/jscpd-report.json" ]; then
    SERVER_DUPES=$(jq '.statistics.total.clones // 0' "$JSCPD_SERVER_TMPDIR/jscpd-report.json")
    SERVER_DUP_LINES=$(jq '.statistics.total.duplicatedLines // 0' "$JSCPD_SERVER_TMPDIR/jscpd-report.json")
    SERVER_TOTAL_LINES=$(jq '.statistics.total.lines // 1' "$JSCPD_SERVER_TMPDIR/jscpd-report.json")
    SERVER_RATE=$(awk -v dup="$SERVER_DUP_LINES" -v total="$SERVER_TOTAL_LINES" 'BEGIN {printf "%.2f%%", dup * 100 / total}')
  else
    SERVER_DUPES=0
    SERVER_RATE="0%"
    echo "  WARNING: jscpd実行失敗またはレポート未生成" >&2
  fi
  rm -rf "$JSCPD_SERVER_TMPDIR"
  echo "  クローン: ${SERVER_DUPES}件, 重複率: ${SERVER_RATE}"
  DUPES=$((DUPES + SERVER_DUPES))
  echo ""
fi

# web
if [ -d "$PROJECT_ROOT/packages/web/src" ]; then
  echo "--- web ---"
  JSCPD_WEB_TMPDIR=$(mktemp -d)
  npx jscpd "$PROJECT_ROOT/packages/web/src" --min-lines 10 --min-tokens 70 \
    --ignore "**/*.test.*,**/*.spec.*" --reporters json --output "$JSCPD_WEB_TMPDIR" >/dev/null 2>&1 || true
  if [ -f "$JSCPD_WEB_TMPDIR/jscpd-report.json" ]; then
    WEB_DUPES=$(jq '.statistics.total.clones // 0' "$JSCPD_WEB_TMPDIR/jscpd-report.json")
    WEB_DUP_LINES=$(jq '.statistics.total.duplicatedLines // 0' "$JSCPD_WEB_TMPDIR/jscpd-report.json")
    WEB_TOTAL_LINES=$(jq '.statistics.total.lines // 1' "$JSCPD_WEB_TMPDIR/jscpd-report.json")
    WEB_RATE=$(awk -v dup="$WEB_DUP_LINES" -v total="$WEB_TOTAL_LINES" 'BEGIN {printf "%.2f%%", dup * 100 / total}')
  else
    WEB_DUPES=0
    WEB_RATE="0%"
    echo "  WARNING: jscpd実行失敗またはレポート未生成" >&2
  fi
  rm -rf "$JSCPD_WEB_TMPDIR"
  echo "  クローン: ${WEB_DUPES}件, 重複率: ${WEB_RATE}"
  DUPES=$((DUPES + WEB_DUPES))
  echo ""
fi

echo ""
echo "=== 結果 ==="
echo "孤立候補: ${FOUND}件"
echo "コード重複: ${DUPES}件"
if [ "$FOUND" -eq 0 ] && [ "$DUPES" -eq 0 ]; then
  echo "問題は検出されませんでした"
fi
