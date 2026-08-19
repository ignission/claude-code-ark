#!/bin/bash
set -eo pipefail

# PreToolUse (Bash) 統合ガードフック
# git push / gh pr create 時のみチェックを実行し、それ以外は即スキップ

# stdinからツール入力JSONを読み取り、コマンドを抽出（パース失敗時はスキップ）
STDIN_INPUT=$(cat)
COMMAND=$(echo "$STDIN_INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./push-marker-utils.sh
source "$SCRIPT_DIR/push-marker-utils.sh"

# --- actual git commit / push の hook bypass だけを拒否する ---
if push_marker_detect_hook_bypass "$COMMAND"; then
  if [ "$PUSH_MARKER_BYPASS_FLAG" = "-n" ]; then
    echo "BLOCKED: -n（--no-verify短縮形）によるgit hookのバイパスは禁止されています" >&2
  else
    echo "BLOCKED: --no-verify によるgit hookのバイパスは禁止されています" >&2
  fi
  echo "  WHY: pre-bash-guard の品質ゲート、または flow P4/P5 のローカル検証がスキップされ、CI で失敗するコードが送信される" >&2
  echo "  FIX: 失敗の根本原因を修正してから commit / push してください" >&2
  exit 2
fi

# --- git commit / git tag はメッセージ内容を検査しない（誤検出防止） ---
if [[ "$COMMAND" =~ ^[[:space:]]*git[[:space:]]+(commit|tag)[[:space:]] ]]; then
  exit 0
fi



# --- pre-push-reviewフラグファイル作成のガード ---
_review_flag_token_is_target() {
  case "$1" in
    claude-pre-push-review-done|*/claude-pre-push-review-done) return 0 ;;
  esac
  return 1
}

_review_flag_is_canonical_touch_segment() {
  local segment target inner subcommand_index

  segment="$(_push_marker_trim "$1")"
  _push_marker_tokenize_segment "$segment" || return 1
  [ "${#PUSH_MARKER_TOKENS[@]}" -eq 2 ] || return 1
  [ "${PUSH_MARKER_TOKENS[0]}" = "touch" ] || return 1
  target="${PUSH_MARKER_TOKENS[1]}"
  case "$target" in
    \$\(*\)/claude-pre-push-review-done) ;;
    *) return 1 ;;
  esac

  inner="${target#\$(}"
  inner="${inner%)/claude-pre-push-review-done}"
  _push_marker_tokenize_segment "$inner" || return 1
  subcommand_index=$(_push_marker_git_subcommand_index) || return 1
  [ "${PUSH_MARKER_TOKENS[$subcommand_index]}" = "rev-parse" ] || return 1
  [ $((subcommand_index + 2)) -eq "${#PUSH_MARKER_TOKENS[@]}" ] || return 1
  case "${PUSH_MARKER_TOKENS[$((subcommand_index + 1))]}" in
    --git-dir|--absolute-git-dir) return 0 ;;
  esac
  return 1
}

_review_flag_segment_creates_flag() {
  local segment token command_token redirection_target
  local command_position=true
  local i j

  segment="$(_push_marker_trim "$1")"
  _push_marker_tokenize_segment "$segment" || return 1

  for ((i = 0; i < ${#PUSH_MARKER_TOKENS[@]}; i++)); do
    token="${PUSH_MARKER_TOKENS[$i]}"

    case "$token" in
      *\>*)
        redirection_target="${token#*>}"
        if [ -z "$redirection_target" ] && [ $((i + 1)) -lt "${#PUSH_MARKER_TOKENS[@]}" ]; then
          redirection_target="${PUSH_MARKER_TOKENS[$((i + 1))]}"
        fi
        _review_flag_token_is_target "$redirection_target" && return 0
        ;;
    esac

    if $command_position; then
      command_token="$token"
      command_position=false
      case "$command_token" in
        touch|install|cp|mv|ln|tee|truncate)
          j=$((i + 1))
          while [ "$j" -lt "${#PUSH_MARKER_TOKENS[@]}" ] && [ "${PUSH_MARKER_TOKENS[$j]}" != "|" ]; do
            _review_flag_token_is_target "${PUSH_MARKER_TOKENS[$j]}" && return 0
            j=$((j + 1))
          done
          ;;
        dd)
          j=$((i + 1))
          while [ "$j" -lt "${#PUSH_MARKER_TOKENS[@]}" ] && [ "${PUSH_MARKER_TOKENS[$j]}" != "|" ]; do
            case "${PUSH_MARKER_TOKENS[$j]}" in
              of=*)
                _review_flag_token_is_target "${PUSH_MARKER_TOKENS[$j]#of=}" && return 0
                ;;
            esac
            j=$((j + 1))
          done
          ;;
      esac
    fi
    [ "$token" = "|" ] && command_position=true
  done
  return 1
}

_push_marker_split_shell_command "$COMMAND"
for REVIEW_FLAG_SEGMENT in "${PUSH_MARKER_SEGMENTS[@]}"; do
  if _review_flag_segment_creates_flag "$REVIEW_FLAG_SEGMENT" && \
     ! _review_flag_is_canonical_touch_segment "$REVIEW_FLAG_SEGMENT"; then
    echo "BLOCKED: pre-push-reviewフラグファイルの手動作成は禁止されています" >&2
    echo "  WHY: /flow の P5 (push 前 codex ゲート) を経ずに PR 作成ガードをバイパスするのを防止" >&2
    echo "  FIX: /flow を実行してください。P5 PASS 時にフラグを自動作成します" >&2
    exit 2
  fi
done


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

# --- gh pr create ガード: pre-push-review 実行済み確認 ---
if [[ "$COMMAND" =~ ^[[:space:]]*gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$) ]]; then
  FLAG_FILE="$(git rev-parse --git-dir)/claude-pre-push-review-done"

  if [ -f "$FLAG_FILE" ]; then
    if find "$FLAG_FILE" -mmin -30 | grep -q .; then
      rm -f "$FLAG_FILE"
      exit 0
    fi
  fi

  echo "BLOCKED: PR作成前に /flow (P5 push 前 codex ゲート) を実行してください" >&2
  echo "  WHY: codex review でのセキュリティ・品質チェックを通さずに PR を作成するのを防止" >&2
  echo "  FIX: /flow を実行 → P5 PASS でフラグ自動作成、または既存 flow なら /flow <#issue|slug> --resume --from P5" >&2
  exit 2
fi

# --- resolveReviewThread ガード: レビューコメントの自動resolveを禁止 ---
if [[ "$COMMAND" =~ resolveReviewThread ]]; then
  echo "BLOCKED: resolveReviewThreadの実行は禁止されています。レビューコメントの解決はユーザーが手動で行ってください" >&2
  exit 2
fi


# --- GitHub PRコメント・返信ガード: push完了マーカー確認 + 先送り表現禁止 ---
# push完了前の返信を防止（バックグラウンドpush時にCodeRabbitが修正を確認できない問題の対策）
# 全てのGitHub PRコメント・返信コマンドをキャッチする（gh api / gh pr comment / gh pr review）

# シェルトークンの引用符・末尾区切りを正規化するヘルパー
_normalize_shell_token() {
  local token="$1"
  token="${token%%[;&|]*}"
  token="${token%\"}"; token="${token#\"}"
  token="${token%\'}"; token="${token#\'}"
  printf '%s' "$token"
}

# GraphQL mutation検出ヘルパー（インライン・query=@file・--input fileに対応）
_is_graphql_mutation() {
  local segment="$1"
  # インラインのmutationキーワードを検出
  [[ "$segment" =~ mutation([[:space:]]|\{|\() ]] && return 0
  # query=@file のファイル内容を検査
  if [[ "$segment" =~ query=@([^[:space:]]+) ]]; then
    local file
    file="$(_normalize_shell_token "${BASH_REMATCH[1]}")"
    [[ -f "$file" ]] && grep -qE 'mutation([[:space:]]|\{|\()' "$file" 2>/dev/null && return 0
  fi
  # --input file のファイル内容を検査（--input - は検査不能なのでスキップ）
  if [[ "$segment" =~ --input[=[:space:]]([^[:space:]]+) ]]; then
    local file
    file="$(_normalize_shell_token "${BASH_REMATCH[1]}")"
    [[ "$file" != "-" ]] && [[ -f "$file" ]] && grep -qE 'mutation([[:space:]]|\{|\()' "$file" 2>/dev/null && return 0
  fi
  return 1
}

# gh apiセグメントを全て抽出して走査（tail -n1ではなく全セグメント対象）
IS_PR_COMMENT=false
if [[ "$COMMAND" =~ gh[[:space:]]+api ]]; then
  while IFS= read -r GH_API_SEGMENT; do
    [[ -z "$GH_API_SEGMENT" ]] && continue
    # gh api REST: コメント系エンドポイント + 書き込みフラグの両方が必要（GETは許可）
    if [[ "$GH_API_SEGMENT" =~ (/issues/[0-9]+/comments|/pulls/[0-9]+/comments|/pulls/[0-9]+/reviews|/comments/[0-9]+/replies) ]] \
      && [[ "$GH_API_SEGMENT" =~ (-f[[:space:]]|-F[[:space:]]|--field[[:space:]]|--raw-field[[:space:]]|--input|(-X|--method)[[:space:]]*(POST|PATCH|PUT)) ]]; then
      IS_PR_COMMENT=true
      break
    # gh api GraphQL: mutationのみキャッチ（queryは許可）
    elif [[ "$GH_API_SEGMENT" =~ graphql ]] && _is_graphql_mutation "$GH_API_SEGMENT"; then
      IS_PR_COMMENT=true
      break
    fi
  done < <(printf '%s\n' "$COMMAND" | grep -oE '(^|[|;&]+[[:space:]]*)gh[[:space:]]+api[^|;&]*')
fi
# gh pr comment / gh pr review: CLIコマンド経由
if ! $IS_PR_COMMENT && [[ "$COMMAND" =~ gh[[:space:]]+pr[[:space:]]+(comment|review)[[:space:]] ]]; then
  IS_PR_COMMENT=true
# gh issue comment: Issue向けコメント
elif ! $IS_PR_COMMENT && [[ "$COMMAND" =~ gh[[:space:]]+issue[[:space:]]+comment[[:space:]] ]]; then
  IS_PR_COMMENT=true
# レガシーパターン: replies.shスクリプト経由
elif ! $IS_PR_COMMENT && [[ "$COMMAND" =~ /replies.sh ]]; then
  IS_PR_COMMENT=true
fi
if $IS_PR_COMMENT; then
  # push完了マーカーの repository + HEAD identity を確認する。
  # 時刻ではなく、現在の project worktree 群に属する同一 commit かで判定する。
  PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
  HOOK_INPUT_CWD=$(echo "$STDIN_INPUT" | jq -r '.cwd // ""' 2>/dev/null) || HOOK_INPUT_CWD=""
  HOOK_CWD=$(pwd -P)
  MARKER="$PROJECT_DIR/.claude/push-completed.marker"
  if [ ! -f "$MARKER" ]; then
    echo "BLOCKED: push完了前にCodeRabbit返信はできません" >&2
    echo "  WHY: push前に返信するとCodeRabbitが修正を確認できない" >&2
    echo "  FIX: 先にgit pushを実行してください" >&2
    exit 2
  fi
  MARKER_HEAD=$(head -1 "$MARKER" 2>/dev/null) || MARKER_HEAD=""
  MARKER_REPO_DIR=$(sed -n '2p' "$MARKER" 2>/dev/null) || MARKER_REPO_DIR=""
  if [ -z "$MARKER_HEAD" ]; then
    echo "BLOCKED: pushマーカーのcommit SHAが空です" >&2
    echo "  WHY: push完了を示すcommit identityを確認できない" >&2
    echo "  FIX: 対象リポジトリでgit pushを再実行してください" >&2
    exit 2
  fi
  if [ -n "$MARKER_REPO_DIR" ]; then
    TARGET_REPO_DIR="$MARKER_REPO_DIR"
  else
    # 旧形式（SHA 1行のみ）のマーカーは返信コマンドから照合先を解決する。
    TARGET_REPO_DIR=$(push_marker_resolve_repo_dir "$HOOK_INPUT_CWD" "$COMMAND" "$HOOK_CWD") || TARGET_REPO_DIR=""
  fi
  if [ -z "$TARGET_REPO_DIR" ] || ! CURRENT_HEAD=$(git -C "$TARGET_REPO_DIR" rev-parse HEAD 2>/dev/null); then
    echo "BLOCKED: pushしたリポジトリのHEADを確認できません" >&2
    echo "  WHY: 照合対象のディレクトリが存在しないか、Gitリポジトリではない" >&2
    echo "  FIX: 対象リポジトリでgit pushを再実行してください" >&2
    exit 2
  fi
  if ! TARGET_COMMON_DIR=$(git -C "$TARGET_REPO_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || \
     ! PROJECT_COMMON_DIR=$(git -C "$PROJECT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
    echo "BLOCKED: pushしたリポジトリのgit common dirを確認できません" >&2
    echo "  WHY: marker または現在のprojectが有効なGitリポジトリではない" >&2
    echo "  FIX: 現在のprojectのworktreeでgit pushを再実行してください" >&2
    exit 2
  fi
  if [ "$TARGET_COMMON_DIR" != "$PROJECT_COMMON_DIR" ]; then
    echo "BLOCKED: pushマーカーが別のリポジトリを指しています" >&2
    echo "  WHY: markerのrepositoryが現在のprojectのworktreeツリーに属していない" >&2
    echo "  FIX: 現在のprojectの対象worktreeでgit pushを再実行してください" >&2
    exit 2
  fi
  if [ "$MARKER_HEAD" != "$CURRENT_HEAD" ]; then
    echo "BLOCKED: push後に新しいコミットが追加されています" >&2
    echo "  WHY: マーカーのSHA(${MARKER_HEAD:0:8})と現在のHEAD(${CURRENT_HEAD:0:8})が不一致" >&2
    echo "  FIX: 最新の変更をgit pushしてから返信してください" >&2
    exit 2
  fi

  # 先送り表現の検出対象テキストを決定（--body-file等からのファイル内容を抽出）
  COMMENT_TEXT="$COMMAND"
  if [[ "$COMMAND" =~ --body-file[=[:space:]]([^[:space:]]+) ]]; then
    BODY_FILE="$(_normalize_shell_token "${BASH_REMATCH[1]}")"
    [[ -f "$BODY_FILE" ]] && COMMENT_TEXT="$(cat "$BODY_FILE")"
  elif [[ "$COMMAND" =~ (-f|-F|--field|--raw-field)[[:space:]]*body=@([^[:space:]]+) ]]; then
    BODY_FILE="$(_normalize_shell_token "${BASH_REMATCH[2]}")"
    [[ -f "$BODY_FILE" ]] && COMMENT_TEXT="$(cat "$BODY_FILE")"
  elif [[ "$COMMAND" =~ --input[=[:space:]]([^[:space:]]+) ]] && [[ "${BASH_REMATCH[1]}" != "-" ]]; then
    INPUT_FILE="$(_normalize_shell_token "${BASH_REMATCH[1]}")"
    [[ -f "$INPUT_FILE" ]] && COMMENT_TEXT="$(jq -r '.. | objects | .body? // empty' "$INPUT_FILE" 2>/dev/null)"
  elif [[ "$COMMAND" =~ --input[=[:space:]]- ]] || [[ "$COMMAND" =~ (--editor|--web) ]]; then
    echo "BLOCKED: 本文を事前検査できないコメント投稿方法は禁止です（--editor / --input - / --web）" >&2
    exit 2
  fi

  # 先送り表現の検出（エージェントはステートレスなので「次回」の保証がない）
  # 「スコープ外」のバリアント（スコープから除外）、「見送り」、「現時点では」「優先度が低い」も検出
  if [[ "$COMMENT_TEXT" =~ (次回|今後|後日|将来的に|検討します|改善予定|後で対応|いずれ対応|追って対応|別チケット|別ticket|後続チケット|後続対応|後続で|スコープ外|スコープから除外|別途対応|見送り|現時点では|優先度が低い) ]]; then
    # Issue番号（#数字）またはJiraチケット番号が含まれていれば許可
    if [[ "$COMMENT_TEXT" =~ \#[0-9]+ ]]; then
      : # Issue番号付きなので許可
    else
      echo "BLOCKED: PRコメント返信に先送り表現が含まれています" >&2
      echo "  WHY: エージェントはステートレスなので次回の保証がない" >&2
      echo "  FIX: (1) このPRで修正する (2) gh issue createでIssue作成してからIssue番号を含めて返信する (3) 技術的根拠を示して対応不要と返信する" >&2
      exit 2
    fi
  fi
fi

# 対象外コマンドは何もせず通過
exit 0
