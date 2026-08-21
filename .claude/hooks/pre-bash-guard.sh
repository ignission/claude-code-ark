#!/bin/bash
set -eo pipefail

# PreToolUse (Bash) 統合ガードフック
# 危険なコマンドと git push 前の品質チェックを実行する

# stdinからツール入力JSONを読み取り、コマンドを抽出（パース失敗時はスキップ）
STDIN_INPUT=$(cat)
COMMAND=$(echo "$STDIN_INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0

# --- actual git commit / push の hook bypass だけを拒否する ---
_guard_tokenize_command() {
  local input="$1"
  local token=""
  local quote=""
  local char
  local i
  local started=false
  local escaped=false

  GUARD_TOKENS=()
  for ((i = 0; i < ${#input}; i++)); do
    char="${input:$i:1}"
    if $escaped; then
      token+="$char"
      started=true
      escaped=false
    elif [ "$char" = "\\" ]; then
      escaped=true
      started=true
    elif [ -n "$quote" ]; then
      if [ "$char" = "$quote" ]; then
        quote=""
      else
        token+="$char"
      fi
      started=true
    else
      case "$char" in
        \"|\') quote="$char"; started=true ;;
        ' '|$'\t'|$'\n')
          if $started; then
            GUARD_TOKENS+=("$token")
            token=""
            started=false
          fi
          ;;
        ';'|'&'|'|')
          if $started; then
            GUARD_TOKENS+=("$token")
            token=""
            started=false
          fi
          GUARD_TOKENS+=("__GUARD_SEPARATOR__")
          ;;
        *) token+="$char"; started=true ;;
      esac
    fi
  done
  $started && GUARD_TOKENS+=("$token")
}

_guard_commit_short_has_no_verify() {
  local token="${1#-}"
  local char
  local i

  GUARD_SHORT_TAKES_VALUE=false
  for ((i = 0; i < ${#token}; i++)); do
    char="${token:$i:1}"
    case "$char" in
      n) return 0 ;;
      m|F|C|c|t)
        [ $((i + 1)) -eq "${#token}" ] && GUARD_SHORT_TAKES_VALUE=true
        return 1
        ;;
    esac
  done
  return 1
}

_guard_detect_hook_bypass() {
  local state="segment-start"
  local token

  _guard_tokenize_command "$1"
  for token in "${GUARD_TOKENS[@]}"; do
    if [ "$token" = "__GUARD_SEPARATOR__" ]; then
      state="segment-start"
      continue
    fi

    case "$state" in
      segment-start)
        if [ "$token" = "git" ]; then
          state="git-options"
        else
          state="segment-ignore"
        fi
        ;;
      git-options)
        case "$token" in
          -C|-c|--git-dir|--work-tree|--exec-path|--namespace|--super-prefix|--config-env)
            state="git-option-value"
            ;;
          --git-dir=*|--work-tree=*|--exec-path=*|--namespace=*|--super-prefix=*|--config-env=*|-*) ;;
          commit) state="commit-args" ;;
          push) state="push-args" ;;
          *) state="segment-ignore" ;;
        esac
        ;;
      git-option-value)
        state="git-options"
        ;;
      commit-args)
        case "$token" in
          --) state="segment-ignore" ;;
          --no-verify)
            HOOK_BYPASS_FLAG="--no-verify"
            return 0
            ;;
          -m|-F|-C|-c|--message|--file|--reuse-message|--reedit-message|--fixup|--squash|--author|--date|--cleanup|--trailer|--pathspec-from-file)
            state="commit-option-value"
            ;;
          --message=*|--file=*|--reuse-message=*|--reedit-message=*|--fixup=*|--squash=*|--author=*|--date=*|--cleanup=*|--trailer=*|--pathspec-from-file=*) ;;
          -?*)
            if _guard_commit_short_has_no_verify "$token"; then
              HOOK_BYPASS_FLAG="-n"
              return 0
            elif $GUARD_SHORT_TAKES_VALUE; then
              state="commit-option-value"
            fi
            ;;
        esac
        ;;
      commit-option-value)
        state="commit-args"
        ;;
      push-args)
        if [ "$token" = "--" ]; then
          state="segment-ignore"
        elif [ "$token" = "--no-verify" ]; then
          HOOK_BYPASS_FLAG="--no-verify"
          return 0
        fi
        ;;
    esac
  done
  return 1
}

HOOK_BYPASS_FLAG=""
_guard_detect_hook_bypass "$COMMAND" || true
if [ -n "$HOOK_BYPASS_FLAG" ]; then
  if [ "$HOOK_BYPASS_FLAG" = "-n" ]; then
    echo "BLOCKED: -n（--no-verify短縮形）によるgit hookのバイパスは禁止されています" >&2
  else
    echo "BLOCKED: --no-verify によるgit hookのバイパスは禁止されています" >&2
  fi
  echo "  WHY: pre-bash-guard の品質ゲートがスキップされ、CI で失敗するコードが送信される" >&2
  echo "  FIX: 失敗の根本原因を修正してから commit / push してください" >&2
  exit 2
fi

# --- git commit / git tag はメッセージ内容を検査しない（誤検出防止） ---
if [[ "$COMMAND" =~ ^[[:space:]]*git[[:space:]]+(commit|tag)[[:space:]] ]]; then
  exit 0
fi
# --- 破壊的コマンドガード ---
# rm -rf: ビルドキャッシュ（node_modules, target, dist, .next, build等）削除のみ許可
# 引数を個別に検査し、全operandがキャッシュ系ディレクトリの場合のみ通過させる
if [[ "$COMMAND" =~ rm[[:space:]]+-[[:alpha:]]*r[[:alpha:]]*f ]] || [[ "$COMMAND" =~ rm[[:space:]]+-[[:alpha:]]*f[[:alpha:]]*r ]] || [[ "$COMMAND" =~ rm[[:space:]]+--recursive[[:space:]]+--force ]] || [[ "$COMMAND" =~ rm[[:space:]]+--force[[:space:]]+--recursive ]] || [[ "$COMMAND" =~ rm[[:space:]]+-r[[:space:]]+-f ]] || [[ "$COMMAND" =~ rm[[:space:]]+-f[[:space:]]+-r ]]; then
  # rm コマンドの引数を抽出（オプション以外）
  SAFE_DIRS="node_modules|target|dist|\.next|build|__pycache__|\.pytest_cache"
  # 引数を1つずつ検査し、全てがキャッシュ系ディレクトリパスか確認
  ALL_SAFE=true
  for arg in $COMMAND; do
    # rm自体とオプション（-で始まる）はスキップ
    case "$arg" in
      rm|-*) continue ;;
    esac
    # 引数のbasenameがキャッシュ系ディレクトリか判定
    arg_base=$(basename "$arg" 2>/dev/null) || arg_base="$arg"
    if ! [[ "$arg_base" =~ ^(${SAFE_DIRS})$ ]]; then
      ALL_SAFE=false
      break
    fi
  done
  if ! $ALL_SAFE; then
    echo "BLOCKED: rm -rf は危険なコマンドです" >&2
    echo "  WHY: エージェントが意図せず重要ファイルを削除するインシデントを防止" >&2
    echo "  FIX: ビルドキャッシュ削除なら rm -rf node_modules / rm -rf target を使用" >&2
    exit 2
  fi
fi

# git reset --hard: 作業ツリーの全変更を破棄する危険なコマンド
if [[ "$COMMAND" =~ git[[:space:]]+reset[[:space:]]+--hard ]]; then
  echo "BLOCKED: git reset --hard は作業ツリーの全変更を破棄する危険なコマンドです" >&2
  echo "  WHY: 未コミットの作業内容が全て失われ、復元不可能になる" >&2
  echo "  FIX: 特定ファイルの復元は git checkout -- <file> を使用" >&2
  exit 2
fi

# git clean -f / git clean -fd: 未追跡ファイルを削除する危険なコマンド
if [[ "$COMMAND" =~ git[[:space:]]+clean[[:space:]]+-[[:alpha:]]*f ]]; then
  echo "BLOCKED: git clean -f は未追跡ファイルを削除する危険なコマンドです" >&2
  echo "  WHY: 新規作成したファイルが全て失われ、復元不可能になる" >&2
  echo "  FIX: 特定ファイルの削除は rm <file> を使用" >&2
  exit 2
fi

# git checkout -- .: ファイル全体の変更を復元する危険なコマンド
if [[ "$COMMAND" =~ git[[:space:]]+checkout[[:space:]]+--[[:space:]]+\. ]]; then
  echo "BLOCKED: git checkout -- . は作業ツリーの全変更を破棄する危険なコマンドです" >&2
  echo "  WHY: 全ファイルの変更が一括で破棄され、復元不可能になる" >&2
  echo "  FIX: 特定ファイルの復元は git checkout -- <specific-file> を使用" >&2
  exit 2
fi

# git push --force / git push -f: --force-with-leaseは許可
if [[ "$COMMAND" =~ git[[:space:]]+(.+[[:space:]]+)?push[[:space:]]+.*--force ]] || [[ "$COMMAND" =~ git[[:space:]]+(.+[[:space:]]+)?push[[:space:]]+.*-f([[:space:]]|$) ]]; then
  if ! [[ "$COMMAND" =~ --force-with-lease ]]; then
    echo "BLOCKED: git push --force は危険なコマンドです" >&2
    echo "  WHY: リモートの他の人のコミットを上書きし、チームの作業が失われる" >&2
    echo "  FIX: --force-with-lease を使用（リモートが変更されていない場合のみ上書き）" >&2
    exit 2
  fi
fi

# chmod 777: 過度な権限付与
if [[ "$COMMAND" =~ chmod[[:space:]]+777 ]]; then
  echo "BLOCKED: chmod 777 は過度な権限付与です" >&2
  echo "  WHY: 全ユーザーに読み書き実行権限を付与し、セキュリティリスクとなる" >&2
  echo "  FIX: 適切な権限 644（ファイル）/ 755（実行可能ファイル）を使用" >&2
  exit 2
fi

# デバイス直接書き込み: /dev/sdX 等への書き込みをブロック
if [[ "$COMMAND" =~ \>[[:space:]]*/dev/sd ]] || [[ "$COMMAND" =~ \>[[:space:]]*/dev/nvme ]] || [[ "$COMMAND" =~ \>[[:space:]]*/dev/hd ]]; then
  echo "BLOCKED: デバイスファイルへの直接書き込みは禁止されています" >&2
  echo "  WHY: ディスクデバイスへの直接書き込みはデータ破壊・OS破損の原因となる" >&2
  echo "  FIX: ファイルへの書き込みは > output.txt を使用" >&2
  exit 2
fi

# --- git push ガード: ソースコード変更時のCIチェック ---
if [[ "$COMMAND" =~ ^[[:space:]]*git[[:space:]]+(.+[[:space:]]+)?push([[:space:]]|$) ]]; then
  PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
  LOG=""

  CHANGED_FILES=$(git diff --name-only origin/main...HEAD 2>/dev/null) || CHANGED_FILES=""
  HAS_SOURCE_CHANGES=$(echo "$CHANGED_FILES" | grep -qE '(^biome\.json$|^package\.json$|\.(ts|tsx|js|jsx|json|css)$)' && echo "1" || echo "0")

  if [ "$HAS_SOURCE_CHANGES" = "1" ]; then
    LOG="${LOG}pre-bash-guard: ソースコードに変更あり。biome・型チェックを実行します...\n"

    LOG="${LOG}pre-bash-guard: biome check を実行中...\n"
    if ! CMD_OUTPUT=$(cd "$PROJECT_ROOT" && npx biome check . 2>&1); then
      echo "$CMD_OUTPUT" >&2
      echo "BLOCKED: biome check が失敗しました。'pnpm format'を実行してからpushしてください" >&2
      exit 2
    fi

    LOG="${LOG}pre-bash-guard: tsc --noEmit を実行中...\n"
    if ! CMD_OUTPUT=$(cd "$PROJECT_ROOT" && npx tsc --noEmit 2>&1); then
      echo "$CMD_OUTPUT" >&2
      echo "BLOCKED: 型チェックが失敗しました。型エラーを修正してからpushしてください" >&2
      exit 2
    fi

    LOG="${LOG}pre-bash-guard: 全チェック成功\n"
  else
    LOG="${LOG}pre-bash-guard: ソースコード変更なし。チェックをスキップします\n"
  fi

  LOG="${LOG}pre-bash-guard: 全てのチェックが成功しました"

  jq -n --arg reason "$LOG" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "allow",
      "permissionDecisionReason": $reason
    }
  }'
  exit 0
fi

# 対象外コマンドは何もせず通過
exit 0
