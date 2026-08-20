#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)
ROOT=$(cd "$SCRIPT_DIR/../../../../.." && pwd -P)
FIXTURES="$SCRIPT_DIR/fixtures"
CAPTURE="$SCRIPT_DIR/capture-post-tool-use-failure.sh"
MCP_SERVER="$SCRIPT_DIR/fixture-mcp-error-server.mjs"
MODE=${1:-all}
USER_CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-${HOME:-}/.claude}

fail() {
  printf 'collector: %s\n' "$1" >&2
  exit 1
}

case "$MODE" in
  resolve|positive|negative|all) ;;
  *) fail "usage: $0 [resolve|positive|negative|all]" ;;
esac

platform=$(node -p 'process.platform' 2>/dev/null) || fail "node platform detection failed"
arch=$(node -p 'process.arch' 2>/dev/null) || fail "node architecture detection failed"
case "$platform" in
  darwin) package_candidates='claude-code-darwin-arm64 claude-code-darwin-x64' ;;
  linux) package_candidates="claude-code-linux-$arch claude-code-linux-$arch-musl" ;;
  *) package_candidates="claude-code-$platform-$arch" ;;
esac

binary=
package_name=
for candidate_package in $package_candidates; do
  candidate="$ROOT/node_modules/@anthropic-ai/$candidate_package/claude"
  if [ -f "$candidate" ] && [ ! -L "$candidate" ] && [ -x "$candidate" ]; then
    binary=$(cd "$(dirname "$candidate")" && pwd -P)/claude
    package_name="@anthropic-ai/$candidate_package"
    break
  fi
  pnpm_dir="$ROOT/node_modules/.pnpm"
  if [ -d "$pnpm_dir" ]; then
    for package_dir in "$pnpm_dir"/@anthropic-ai+"$candidate_package"@*; do
      [ -d "$package_dir" ] || continue
      candidate="$package_dir/node_modules/@anthropic-ai/$candidate_package/claude"
      if [ -f "$candidate" ] && [ ! -L "$candidate" ] && [ -x "$candidate" ]; then
        binary=$(cd "$(dirname "$candidate")" && pwd -P)/claude
        package_name="@anthropic-ai/$candidate_package"
        break
      fi
    done
  fi
  [ -z "$binary" ] || break
done
[ -n "$binary" ] || fail "bundled Claude Code platform binary was not resolved"

version_stdout_file=$(mktemp)
version_stderr_file=$(mktemp)
cleanup_version() { rm -f "$version_stdout_file" "$version_stderr_file"; }
trap cleanup_version EXIT HUP INT TERM
"$binary" --version >"$version_stdout_file" 2>"$version_stderr_file"
version_status=$?
if [ "$version_status" -ne 0 ]; then
  printf 'binary=%s\nstdout:\n' "$binary" >&2
  sed -n '1,20p' "$version_stdout_file" >&2
  printf 'stderr:\n' >&2
  sed -n '1,20p' "$version_stderr_file" >&2
  printf 'exit_code=%s\n' "$version_status" >&2
  exit 1
fi
version_output=$(cat "$version_stdout_file")
case "$version_output" in
  [0-9]*.[0-9]*.[0-9]*' (Claude Code)') ;;
  *)
    printf 'binary=%s\nstdout:\n%s\nstderr:\n' "$binary" "$version_output" >&2
    sed -n '1,20p' "$version_stderr_file" >&2
    printf 'exit_code=%s\n' "$version_status" >&2
    exit 1
    ;;
esac
version=${version_output%% *}
case "$version" in
  *[!0-9.]*) fail "resolved version is not semver: $version" ;;
esac

printf 'binary=%s\npackage=%s\nplatform=%s\narch=%s\nclaude_version=%s\nversion_exit_code=%s\n' \
  "$binary" "$package_name" "$platform" "$arch" "$version_output" "$version_status"
[ "$MODE" = resolve ] && exit 0

mkdir -p "$FIXTURES" || fail "cannot create fixture directory"
for recorded_provenance in "$FIXTURES"/post-tool-use-failure-provenance-*.txt; do
  [ -f "$recorded_provenance" ] || continue
  [ "$(basename "$recorded_provenance")" = "post-tool-use-failure-provenance-$version.txt" ] \
    || fail "existing provenance version does not match resolved version $version"
  grep -F "claude_version=$version_output" "$recorded_provenance" >/dev/null 2>&1 \
    || fail "existing provenance version output does not match this collection"
done
tmp=$(mktemp -d)
tmp=$(cd "$tmp" && pwd -P)
cleanup() {
  if [ "${ARK_KEEP_FIXTURE_TMP:-}" = 1 ]; then
    printf 'collector temporary directory retained: %s\n' "$tmp" >&2
  else
    rm -rf "$tmp"
  fi
  cleanup_version
}
trap cleanup EXIT HUP INT TERM
repo="$tmp/repo"
config_dir="$tmp/claude-config"
mkdir -m 700 "$repo" "$config_dir"
git -C "$repo" init -q || fail "temporary git repository initialization failed"
git -C "$repo" config user.name fixture
git -C "$repo" config user.email fixture@example.invalid
if [ -f "$USER_CLAUDE_CONFIG_DIR/.credentials.json" ] && [ ! -L "$USER_CLAUDE_CONFIG_DIR/.credentials.json" ]; then
  cp "$USER_CLAUDE_CONFIG_DIR/.credentials.json" "$config_dir/.credentials.json" \
    || fail "Claude authentication could not be copied into the dedicated config directory"
  chmod 600 "$config_dir/.credentials.json"
fi

write_settings() {
  target=$1
  deny_bash=$2
  if [ "$deny_bash" = 1 ]; then
    jq -n --arg command "$CAPTURE" '{hooks:{PostToolUseFailure:[{hooks:[{type:"command",command:$command}]}]},permissions:{deny:["Bash(*)"]}}' >"$target"
  else
    jq -n --arg command "$CAPTURE" '{hooks:{PostToolUseFailure:[{hooks:[{type:"command",command:$command}]}]}}' >"$target"
  fi
  chmod 600 "$target"
}

write_mcp_config() {
  target=$1
  validation=$2
  if [ "$validation" = 1 ]; then
    jq -n --arg command "$(command -v node)" --arg server "$MCP_SERVER" \
      '{mcpServers:{fixture:{command:$command,args:[$server,"--validation"]}}}' >"$target"
  else
    jq -n --arg command "$(command -v node)" --arg server "$MCP_SERVER" \
      '{mcpServers:{fixture:{command:$command,args:[$server]}}}' >"$target"
  fi
  chmod 600 "$target"
}

sanitize_text() {
  sed -e "s|$tmp|<fixture-tmp>|g" -e "s|$ROOT|<workspace>|g" -e "s|${HOME:-/nonexistent}|<home>|g"
}

run_claude() {
  case_name=$1
  prompt=$2
  tools=$3
  deny_bash=$4
  validation=$5
  out="$tmp/$case_name.json"
  debug="$tmp/$case_name.debug"
  transcript="$tmp/$case_name.stdout"
  settings="$config_dir/settings.json"
  mcp="$tmp/$case_name.mcp.json"
  marker="$tmp/$case_name.tools-call"
  invocations="$tmp/$case_name.invocations"
  mkdir -m 700 "$invocations"
  permission_mode=bypassPermissions
  [ "$deny_bash" = 0 ] || permission_mode=dontAsk
  : >"$out"
  chmod 600 "$out"
  write_settings "$settings" "$deny_bash"
  write_mcp_config "$mcp" "$validation"
  (
    cd "$repo" || exit 1
    ARK_HOOK_FIXTURE_OUT="$out" ARK_HOOK_FIXTURE_INVOCATIONS="$invocations" \
      ARK_MCP_CALL_MARKER="$marker" CLAUDE_CONFIG_DIR="$config_dir" \
      "$binary" -p "$prompt" --tools "$tools" --permission-mode "$permission_mode" \
      --setting-sources user --strict-mcp-config --mcp-config "$mcp" \
      --no-session-persistence --debug-file "$debug" >"$transcript" 2>"$tmp/$case_name.stderr"
  )
  claude_status=$?
  printf '%s\n' "$claude_status" >"$tmp/$case_name.status"
}

positive_case() {
  name=$1
  prompt=$2
  tools=$3
  destination="$FIXTURES/post-tool-use-failure-$name-$version.json"
  run_claude "$name" "$prompt" "$tools" 0 0
  source="$tmp/$name.json"
  if [ ! -s "$source" ]; then
    printf '%s status=%s\n' "$name" "$(cat "$tmp/$name.status")" >&2
    printf '%s stderr:\n' "$name" >&2
    sanitize_text <"$tmp/$name.stderr" | sed -n '1,40p' >&2
    printf '%s stdout:\n' "$name" >&2
    sanitize_text <"$tmp/$name.stdout" | sed -n '1,40p' >&2
    printf '%s relevant debug:\n' "$name" >&2
    sanitize_text <"$tmp/$name.debug" | grep -E 'auth|error|hook|tool|login' | tail -80 >&2
    fail "$name did not produce a PostToolUseFailure capture"
  fi
  jq -e 'type == "object" and .hook_event_name == "PostToolUseFailure"' "$source" >/dev/null \
    || fail "$name produced an invalid hook envelope"
  invocation_count=$(find "$tmp/$name.invocations" -type f -name 'invocation-*' | wc -l | tr -d ' ')
  [ "$invocation_count" = 1 ] || fail "$name capture count was $invocation_count, expected 1"
  sanitize_text <"$source" >"$destination"
  jq -e 'type == "object"' "$destination" >/dev/null || fail "$name sanitization damaged JSON"
  chmod 644 "$destination"
}

if [ "$MODE" = positive ] || [ "$MODE" = all ]; then
  positive_case bash-exit-7 \
    "Call the Bash tool exactly once with the exact command /bin/sh -c 'exit 7'. Do not call another tool. After the tool fails, reply done." \
    Bash
  positive_case mcp-error \
    "Call mcp__fixture__fixture_fail exactly once with an empty object. Do not call another tool. After it returns an error, reply done." \
    mcp__fixture__fixture_fail
  positive_case read-missing \
    "Call Read exactly once for the absolute path $repo/definitely-missing-fixture-file. Do not call another tool. After it fails, reply done." \
    Read
fi

if [ "$MODE" = negative ] || [ "$MODE" = all ]; then
  run_claude permission-deny \
    "Call Bash exactly once with the exact command printf denied. Do not call another tool. After the denial, reply done." \
    Bash 1 0
  run_claude validation-rejection \
    "Call mcp__fixture__fixture_fail exactly once with required_integer set to the string not-an-integer, not a number. Do not call another tool. After validation rejects it, reply done." \
    mcp__fixture__fixture_fail 0 1
fi

provenance="$FIXTURES/post-tool-use-failure-provenance-$version.txt"
{
  printf 'binary=%s\n' "$binary"
  printf 'package=%s\n' "$package_name"
  printf 'platform=%s\n' "$platform"
  printf 'arch=%s\n' "$arch"
  printf 'claude_version=%s\n' "$version_output"
  printf 'version_exit_code=%s\n' "$version_status"
  if [ "$MODE" = positive ] || [ "$MODE" = all ]; then
    for recorded_case in bash-exit-7 mcp-error read-missing; do
      recorded_fixture="$FIXTURES/post-tool-use-failure-$recorded_case-$version.json"
      printf '%s_capture_count=1\n' "$recorded_case"
      printf '%s_keys_unsorted=%s\n' "$recorded_case" "$(jq -c 'keys_unsorted' "$recorded_fixture")"
      printf '%s_types=%s\n' "$recorded_case" "$(jq -c 'to_entries | map({key:.key,type:(.value|type)})' "$recorded_fixture")"
      printf '%s_error=%s\n' "$recorded_case" "$(jq -c '.error' "$recorded_fixture")"
      printf '%s_tool_name=%s\n' "$recorded_case" "$(jq -c '.tool_name' "$recorded_fixture")"
      printf '%s_tool_input_type=%s\n' "$recorded_case" "$(jq -r '.tool_input | type' "$recorded_fixture")"
      printf '%s_is_interrupt=%s\n' "$recorded_case" "$(jq -c '.is_interrupt' "$recorded_fixture")"
      printf '%s_duration_ms_type=%s\n' "$recorded_case" "$(jq -r '.duration_ms | type' "$recorded_fixture")"
      printf '%s_error_type_field=absent\n' "$recorded_case"
      printf '%s_normalized_error_type=tool_error\n' "$recorded_case"
      printf '%s_exit_code_field=absent\n' "$recorded_case"
      printf '%s_tool_response_field=absent\n' "$recorded_case"
      if [ "$recorded_case" = bash-exit-7 ]; then
        printf '%s_normalized_exit_code=7\n' "$recorded_case"
        printf '%s_exit_code_source=error_exact_Exit_code_integer\n' "$recorded_case"
      else
        printf '%s_normalized_exit_code=null\n' "$recorded_case"
        printf '%s_exit_code_source=none\n' "$recorded_case"
      fi
    done
  fi
} >"$provenance"
chmod 644 "$provenance"

printf 'collector completed mode=%s version=%s\n' "$MODE" "$version"
