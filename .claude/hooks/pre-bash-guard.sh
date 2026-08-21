#!/bin/bash
set -eo pipefail

# zsh で直接実行された場合も Bash と同じ 0 始まりの配列添字に揃える。
if [ -n "${ZSH_VERSION:-}" ]; then
  setopt KSH_ARRAYS
fi

# PreToolUse (Bash) 統合ガードフック
# 危険なコマンドと git push 前の品質チェックを実行する

# stdinからツール入力JSONを読み取り、コマンドを抽出（パース失敗時はスキップ）
STDIN_INPUT=$(cat)
COMMAND=$(echo "$STDIN_INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0

# 生のコマンドと、引用文字列・ヒアドキュメント本文を除いた検査用コマンドを
# セグメント単位で対にして保持する。Bash 3.2 互換のため連想配列は使わない。
GUARD_RAW_SEGMENTS=()
GUARD_SEGMENTS=()

_guard_add_segment() {
  local raw="$1"
  local executable="$2"

  if [ -n "$raw$executable" ]; then
    GUARD_RAW_SEGMENTS+=("$raw")
    GUARD_SEGMENTS+=("$executable")
  fi
}

_guard_extract_dollar_substitution() {
  local input="$1"
  local start="$2"
  local depth=1
  local quote=""
  local escaped=false
  local char next
  local i

  GUARD_SUB_FOUND=false
  GUARD_SUB_CONTENT=""
  GUARD_SUB_END="$start"
  for ((i = start + 2; i < ${#input}; i++)); do
    char="${input:$i:1}"
    next="${input:$((i + 1)):1}"
    if [ "$escaped" = true ]; then
      escaped=false
    elif [ "$char" = "\\" ] && [ "$quote" != "'" ]; then
      escaped=true
    elif [ -n "$quote" ]; then
      if [ "$char" = "$quote" ]; then
        quote=""
      elif [ "$quote" = '"' ] && [ "$char" = '$' ] && [ "$next" = '(' ]; then
        _guard_extract_dollar_substitution "$input" "$i"
        if [ "$GUARD_SUB_FOUND" = true ]; then
          i="$GUARD_SUB_END"
        fi
      fi
    else
      case "$char" in
        \"|\'|\`) quote="$char" ;;
        '(') depth=$((depth + 1)) ;;
        ')')
          depth=$((depth - 1))
          if [ "$depth" -eq 0 ]; then
            GUARD_SUB_CONTENT="${input:$((start + 2)):$((i - start - 2))}"
            GUARD_SUB_END="$i"
            GUARD_SUB_FOUND=true
            return
          fi
          ;;
      esac
    fi
  done
}

_guard_extract_backtick_substitution() {
  local input="$1"
  local start="$2"
  local escaped=false
  local char
  local i

  GUARD_SUB_FOUND=false
  GUARD_SUB_CONTENT=""
  GUARD_SUB_END="$start"
  for ((i = start + 1; i < ${#input}; i++)); do
    char="${input:$i:1}"
    if [ "$escaped" = true ]; then
      escaped=false
    elif [ "$char" = "\\" ]; then
      escaped=true
    elif [ "$char" = '`' ]; then
      GUARD_SUB_CONTENT="${input:$((start + 1)):$((i - start - 1))}"
      GUARD_SUB_END="$i"
      GUARD_SUB_FOUND=true
      return
    fi
  done
}

_guard_skip_one_heredoc() {
  local input="$1"
  local start="$2"
  local delimiter="$3"
  local strip_tabs="$4"
  local line compare
  local line_start="$start"
  local line_end

  GUARD_HEREDOC_NEXT_INDEX="${#input}"
  while [ "$line_start" -le "${#input}" ]; do
    line_end="$line_start"
    while [ "$line_end" -lt "${#input}" ] && [ "${input:$line_end:1}" != $'\n' ]; do
      line_end=$((line_end + 1))
    done
    line="${input:$line_start:$((line_end - line_start))}"
    [ "${line%$'\r'}" != "$line" ] && line="${line%$'\r'}"
    compare="$line"
    if [ "$strip_tabs" = true ]; then
      while [ "${compare#$'\t'}" != "$compare" ]; do
        compare="${compare#$'\t'}"
      done
    fi
    if [ "$compare" = "$delimiter" ]; then
      if [ "$line_end" -lt "${#input}" ]; then
        GUARD_HEREDOC_NEXT_INDEX=$((line_end + 1))
      else
        GUARD_HEREDOC_NEXT_INDEX="$line_end"
      fi
      return
    fi
    if [ "$line_end" -ge "${#input}" ]; then
      return
    fi
    line_start=$((line_end + 1))
  done
}

_guard_parse_command() {
  local input="$1"
  local raw=""
  local executable=""
  local quote=""
  local escaped=false
  local char next third
  local delimiter delimiter_quote delimiter_raw strip_tabs
  local sub_content sub_end
  local i j h next_index
  local -a heredoc_delimiters=()
  local -a heredoc_strip_tabs=()

  for ((i = 0; i < ${#input}; i++)); do
    char="${input:$i:1}"
    next="${input:$((i + 1)):1}"
    third="${input:$((i + 2)):1}"

    if [ "$escaped" = true ]; then
      raw+="$char"
      executable+="$char"
      escaped=false
    elif [ "$char" = "\\" ] && [ "$quote" != "'" ]; then
      raw+="$char"
      executable+="$char"
      escaped=true
    elif [ -n "$quote" ]; then
      raw+="$char"
      if [ "$char" = "$quote" ]; then
        quote=""
      elif [ "$quote" = '"' ] && [ "$char" = '$' ] && [ "$next" = '(' ]; then
        _guard_extract_dollar_substitution "$input" "$i"
        if [ "$GUARD_SUB_FOUND" = true ]; then
          sub_content="$GUARD_SUB_CONTENT"
          sub_end="$GUARD_SUB_END"
          raw+="${input:$((i + 1)):$((sub_end - i))}"
          executable+=' '
          _guard_parse_command "$sub_content"
          i="$sub_end"
        fi
      elif [ "$quote" = '"' ] && [ "$char" = '`' ]; then
        _guard_extract_backtick_substitution "$input" "$i"
        if [ "$GUARD_SUB_FOUND" = true ]; then
          sub_content="$GUARD_SUB_CONTENT"
          sub_end="$GUARD_SUB_END"
          raw+="${input:$((i + 1)):$((sub_end - i))}"
          executable+=' '
          _guard_parse_command "$sub_content"
          i="$sub_end"
        fi
      fi
    else
      case "$char" in
        \"|\')
          raw+="$char"
          executable+=' '
          quote="$char"
          ;;
        '$')
          if [ "$next" = '(' ]; then
            _guard_extract_dollar_substitution "$input" "$i"
            if [ "$GUARD_SUB_FOUND" = true ]; then
              sub_content="$GUARD_SUB_CONTENT"
              sub_end="$GUARD_SUB_END"
              raw+="${input:$i:$((sub_end - i + 1))}"
              executable+=' '
              _guard_parse_command "$sub_content"
              i="$sub_end"
            else
              raw+="$char"
              executable+="$char"
            fi
          else
            raw+="$char"
            executable+="$char"
          fi
          ;;
        '`')
          _guard_extract_backtick_substitution "$input" "$i"
          if [ "$GUARD_SUB_FOUND" = true ]; then
            sub_content="$GUARD_SUB_CONTENT"
            sub_end="$GUARD_SUB_END"
            raw+="${input:$i:$((sub_end - i + 1))}"
            executable+=' '
            _guard_parse_command "$sub_content"
            i="$sub_end"
          else
            raw+="$char"
            executable+="$char"
          fi
          ;;
        '<')
          if [ "$next" = '<' ] && [ "$third" != '<' ]; then
            j=$((i + 2))
            strip_tabs=false
            if [ "${input:$j:1}" = '-' ]; then
              strip_tabs=true
              j=$((j + 1))
            fi
            while [ "${input:$j:1}" = ' ' ] || [ "${input:$j:1}" = $'\t' ]; do
              j=$((j + 1))
            done
            delimiter=""
            delimiter_raw=""
            delimiter_quote=""
            while [ "$j" -lt "${#input}" ]; do
              char="${input:$j:1}"
              if [ -n "$delimiter_quote" ]; then
                delimiter_raw+="$char"
                if [ "$char" = "$delimiter_quote" ]; then
                  delimiter_quote=""
                else
                  delimiter+="$char"
                fi
              else
                case "$char" in
                  \"|\') delimiter_quote="$char"; delimiter_raw+="$char" ;;
                  \\)
                    delimiter_raw+="$char"
                    j=$((j + 1))
                    if [ "$j" -lt "${#input}" ]; then
                      char="${input:$j:1}"
                      delimiter_raw+="$char"
                      delimiter+="$char"
                    fi
                    ;;
                  ' '|$'\t'|$'\n'|';'|'&'|'|') break ;;
                  *) delimiter_raw+="$char"; delimiter+="$char" ;;
                esac
              fi
              j=$((j + 1))
            done
            raw+="${input:$i:$((j - i))}"
            executable+=' << '
            if [ -n "$delimiter" ]; then
              heredoc_delimiters+=("$delimiter")
              heredoc_strip_tabs+=("$strip_tabs")
            fi
            i=$((j - 1))
          else
            raw+="$char"
            executable+="$char"
          fi
          ;;
        ';'|'&'|'|')
          _guard_add_segment "$raw" "$executable"
          raw=""
          executable=""
          if { [ "$char" = '&' ] && [ "$next" = '&' ]; } ||
             { [ "$char" = '|' ] && [ "$next" = '|' ]; }; then
            i=$((i + 1))
          fi
          ;;
        $'\n')
          _guard_add_segment "$raw" "$executable"
          raw=""
          executable=""
          if [ "${#heredoc_delimiters[@]}" -gt 0 ]; then
            next_index=$((i + 1))
            for ((h = 0; h < ${#heredoc_delimiters[@]}; h++)); do
              _guard_skip_one_heredoc "$input" "$next_index" \
                "${heredoc_delimiters[$h]}" "${heredoc_strip_tabs[$h]}"
              next_index="$GUARD_HEREDOC_NEXT_INDEX"
            done
            heredoc_delimiters=()
            heredoc_strip_tabs=()
            i=$((next_index - 1))
          fi
          ;;
        *) raw+="$char"; executable+="$char" ;;
      esac
    fi
  done
  _guard_add_segment "$raw" "$executable"
}

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
    elif [ "$char" = "\\" ] && [ "$quote" != "'" ]; then
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
  return 0
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
  local state
  local token
  local raw_segment

  for raw_segment in "${GUARD_RAW_SEGMENTS[@]}"; do
    state="segment-start"
    _guard_tokenize_command "$raw_segment"
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
          # 未知の long option は短縮形クラスタではない。先に落とさないと
          # `--no-edit` / `--dry-run` が `-n` と誤認される。
          --*) ;;
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
  done
  return 1
}

_guard_collect_interpreter_command() {
  local raw_segment="$1"
  local shell_name token
  local i

  _guard_tokenize_command "$raw_segment"
  [ "${#GUARD_TOKENS[@]}" -gt 0 ] || return 0
  shell_name="${GUARD_TOKENS[0]##*/}"
  case "$shell_name" in
    sh|bash|zsh) ;;
    *) return ;;
  esac

  for ((i = 1; i < ${#GUARD_TOKENS[@]}; i++)); do
    token="${GUARD_TOKENS[$i]}"
    case "$token" in
      -c|-[^-]*c*)
        if [ $((i + 1)) -lt "${#GUARD_TOKENS[@]}" ]; then
          _guard_parse_command "${GUARD_TOKENS[$((i + 1))]}"
        fi
        return
        ;;
    esac
  done
  return 0
}

_guard_parse_command "$COMMAND"
GUARD_INITIAL_SEGMENT_COUNT="${#GUARD_RAW_SEGMENTS[@]}"
for ((GUARD_INDEX = 0; GUARD_INDEX < GUARD_INITIAL_SEGMENT_COUNT; GUARD_INDEX++)); do
  _guard_collect_interpreter_command "${GUARD_RAW_SEGMENTS[$GUARD_INDEX]}"
done

HOOK_BYPASS_FLAG=""
_guard_detect_hook_bypass || true
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

# --- 破壊的コマンドガード ---
# 各セグメントを独立して検査し、前の git push の状態を後続へ持ち越さない。
_guard_check_dangerous_segment() {
  local segment="$1"
  local raw_segment="$2"
  local arg arg_base
  local found_rm=false
  local all_safe=true
  local safe_dirs="node_modules|target|dist|\.next|build|__pycache__|\.pytest_cache"

  # git commit / git tag はメッセージ内容を検査しない（誤検出防止）。
  if [[ "$segment" =~ ^[[:space:]]*git[[:space:]]+(commit|tag)([[:space:]]|$) ]]; then
    return
  fi

  # rm -rf: 全 operand がキャッシュ系ディレクトリの場合のみ通過させる。
  if [[ "$segment" =~ rm[[:space:]]+-[[:alpha:]]*r[[:alpha:]]*f ]] || [[ "$segment" =~ rm[[:space:]]+-[[:alpha:]]*f[[:alpha:]]*r ]] || [[ "$segment" =~ rm[[:space:]]+--recursive[[:space:]]+--force ]] || [[ "$segment" =~ rm[[:space:]]+--force[[:space:]]+--recursive ]] || [[ "$segment" =~ rm[[:space:]]+-r[[:space:]]+-f ]] || [[ "$segment" =~ rm[[:space:]]+-f[[:space:]]+-r ]]; then
    _guard_tokenize_command "$raw_segment"
    for arg in "${GUARD_TOKENS[@]}"; do
      if [ "$found_rm" = false ]; then
        [ "$arg" = "rm" ] && found_rm=true
        continue
      fi
      case "$arg" in
        -*) continue ;;
      esac
      arg_base=$(basename "$arg" 2>/dev/null) || arg_base="$arg"
      if ! [[ "$arg_base" =~ ^(${safe_dirs})$ ]]; then
        all_safe=false
        break
      fi
    done
    if [ "$all_safe" = false ]; then
      echo "BLOCKED: rm -rf は危険なコマンドです" >&2
      echo "  WHY: エージェントが意図せず重要ファイルを削除するインシデントを防止" >&2
      echo "  FIX: ビルドキャッシュ削除なら rm -rf node_modules / rm -rf target を使用" >&2
      exit 2
    fi
  fi

  if [[ "$segment" =~ git[[:space:]]+reset[[:space:]]+--hard ]]; then
    echo "BLOCKED: git reset --hard は作業ツリーの全変更を破棄する危険なコマンドです" >&2
    echo "  WHY: 未コミットの作業内容が全て失われ、復元不可能になる" >&2
    echo "  FIX: 特定ファイルの復元は git checkout -- <file> を使用" >&2
    exit 2
  fi

  if [[ "$segment" =~ git[[:space:]]+clean[[:space:]]+-[[:alpha:]]*f ]]; then
    echo "BLOCKED: git clean -f は未追跡ファイルを削除する危険なコマンドです" >&2
    echo "  WHY: 新規作成したファイルが全て失われ、復元不可能になる" >&2
    echo "  FIX: 特定ファイルの削除は rm <file> を使用" >&2
    exit 2
  fi

  if [[ "$segment" =~ git[[:space:]]+checkout[[:space:]]+--[[:space:]]+\. ]]; then
    echo "BLOCKED: git checkout -- . は作業ツリーの全変更を破棄する危険なコマンドです" >&2
    echo "  WHY: 全ファイルの変更が一括で破棄され、復元不可能になる" >&2
    echo "  FIX: 特定ファイルの復元は git checkout -- <specific-file> を使用" >&2
    exit 2
  fi

  if [[ "$segment" =~ git[[:space:]]+(.+[[:space:]]+)?push[[:space:]]+.*--force ]] || [[ "$segment" =~ git[[:space:]]+(.+[[:space:]]+)?push[[:space:]]+.*-f([[:space:]]|$) ]]; then
    if ! [[ "$segment" =~ --force-with-lease ]]; then
      echo "BLOCKED: git push --force は危険なコマンドです" >&2
      echo "  WHY: リモートの他の人のコミットを上書きし、チームの作業が失われる" >&2
      echo "  FIX: --force-with-lease を使用（リモートが変更されていない場合のみ上書き）" >&2
      exit 2
    fi
  fi

  if [[ "$segment" =~ chmod[[:space:]]+777 ]]; then
    echo "BLOCKED: chmod 777 は過度な権限付与です" >&2
    echo "  WHY: 全ユーザーに読み書き実行権限を付与し、セキュリティリスクとなる" >&2
    echo "  FIX: 適切な権限 644（ファイル）/ 755（実行可能ファイル）を使用" >&2
    exit 2
  fi

  if [[ "$segment" =~ \>[[:space:]]*/dev/sd ]] || [[ "$segment" =~ \>[[:space:]]*/dev/nvme ]] || [[ "$segment" =~ \>[[:space:]]*/dev/hd ]]; then
    echo "BLOCKED: デバイスファイルへの直接書き込みは禁止されています" >&2
    echo "  WHY: ディスクデバイスへの直接書き込みはデータ破壊・OS破損の原因となる" >&2
    echo "  FIX: ファイルへの書き込みは > output.txt を使用" >&2
    exit 2
  fi

  if [[ "$segment" =~ resolveReviewThread ]]; then
    echo "BLOCKED: resolveReviewThreadの実行は禁止されています。レビューコメントの解決はユーザーが手動で行ってください" >&2
    exit 2
  fi
}

GUARD_HAS_PUSH=false
for ((GUARD_INDEX = 0; GUARD_INDEX < ${#GUARD_SEGMENTS[@]}; GUARD_INDEX++)); do
  GUARD_SEGMENT="${GUARD_SEGMENTS[$GUARD_INDEX]}"
  _guard_check_dangerous_segment "$GUARD_SEGMENT" "${GUARD_RAW_SEGMENTS[$GUARD_INDEX]}"
  if [[ "$GUARD_SEGMENT" =~ ^[[:space:]]*git[[:space:]]+(.+[[:space:]]+)?push([[:space:]]|$) ]]; then
    GUARD_HAS_PUSH=true
  fi
done

# --- git push ガード: ソースコード変更時のCIチェック ---
if [ "$GUARD_HAS_PUSH" = true ]; then
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
