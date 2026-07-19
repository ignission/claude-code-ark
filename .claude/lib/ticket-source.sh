#!/usr/bin/env bash
# .claude/lib/ticket-source.sh
# flow skill のチケット種別判定ヘルパー。
# ark は GitHub Issue (issue-XXX) のみを正式チケットとして扱う
# (Jira 等の外部チケットソースは扱わない)。
#
# 利用想定:
#   source "$CLAUDE_PROJECT_DIR/.claude/lib/ticket-source.sh"
#   ticket_validate "issue-704"        # 0
#   ticket_validate "foo"              # 1
#   ticket_kind     "issue-704"        # "issue"
#   ticket_number   "issue-704"        # "704"
#   ticket_to_branch_prefix "issue-704"  # "feature/issue-704"
#
# 設計判断:
#   - GitHub Issue の実照会 (gh CLI) は呼び出し側 (skill / Claude) が行う。
#     本ヘルパーは判定と命名規約の共通化のみを担う
#   - 末尾改行なしで printf する (パイプで使うときに余計な空白が混じらないように)

# 共通正規表現
_FLOW_TICKET_REGEX_ISSUE='^issue-[0-9]+$'
_FLOW_BRANCH_REGEX='^feature/issue-[0-9]+/.+$'

# チケット形式が issue-N に合致するか判定。
# 引数: $1 ticket
# 戻り値: 0=valid, 1=invalid
ticket_validate() {
  local ticket="${1:-}"
  [[ "$ticket" =~ $_FLOW_TICKET_REGEX_ISSUE ]]
}

# チケット種別を返す (ark は issue のみ。複数ソース対応時の共通インタフェース維持用)。
# 引数: $1 ticket
# 出力: "issue"
# 戻り値: 0=ok, 1=invalid format
ticket_kind() {
  local ticket="${1:-}"
  if [[ "$ticket" =~ $_FLOW_TICKET_REGEX_ISSUE ]]; then
    printf 'issue'
  else
    echo "ERROR: invalid ticket format: $ticket (expected issue-N)" >&2
    return 1
  fi
}

# チケットの数字部分を返す。
# 引数: $1 ticket
# 出力: 数字のみ (issue-704 → 704)
ticket_number() {
  local ticket="${1:-}"
  if ! ticket_validate "$ticket"; then
    echo "ERROR: invalid ticket format: $ticket" >&2
    return 1
  fi
  printf '%s' "${ticket#*-}"
}

# ブランチ命名規約の prefix を返す。
# 引数: $1 ticket
# 出力: feature/issue-XXX
ticket_to_branch_prefix() {
  local ticket="${1:-}"
  if ! ticket_validate "$ticket"; then
    echo "ERROR: invalid ticket format: $ticket" >&2
    return 1
  fi
  printf 'feature/%s' "$ticket"
}

# ブランチ名がチケット規約に合致するか判定。
# 引数: $1 branch
# 戻り値: 0=valid, 1=invalid
ticket_branch_validate() {
  local branch="${1:-}"
  [[ "$branch" =~ $_FLOW_BRANCH_REGEX ]]
}

# ブランチ名からチケット ID を抽出。
# 引数: $1 branch (feature/issue-<N>/<slug>)
# 出力: issue-XXX
ticket_from_branch() {
  local branch="${1:-}"
  if ! ticket_branch_validate "$branch"; then
    echo "ERROR: invalid branch format: $branch" >&2
    return 1
  fi
  # feature/<TICKET>/<slug> の <TICKET> を抜き出す
  local rest="${branch#feature/}"
  printf '%s' "${rest%%/*}"
}

# GitHub Issue (issue-N) かどうかを真偽で返す。
# 引数: $1 ticket
# 戻り値: 0=issue, 1=invalid
ticket_is_issue() {
  local ticket="${1:-}"
  [[ "$ticket" =~ $_FLOW_TICKET_REGEX_ISSUE ]]
}
