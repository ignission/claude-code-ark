#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)
ROOT=$(cd "$SCRIPT_DIR/../../../../.." && pwd -P)
FIXTURES="$SCRIPT_DIR/fixtures"
CAPTURE="$SCRIPT_DIR/capture-post-tool-use-failure.sh"
MCP_SERVER="$SCRIPT_DIR/fixture-mcp-error-server.mjs"
MODE=${1:-all}

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
tmp=$(mktemp -d)
tmp=$(cd "$tmp" && pwd -P)
cleanup() { rm -rf "$tmp"; cleanup_version; }
trap cleanup EXIT HUP INT TERM
repo="$tmp/repo"
config_dir="$tmp/claude-config"
mkdir -m 700 "$repo" "$config_dir"
git -C "$repo" init -q || fail "temporary git repository initialization failed"
git -C "$repo" config user.name fixture
git -C "$repo" config user.email fixture@example.invalid

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
  settings="$tmp/$case_name.settings.json"
  mcp="$tmp/$case_name.mcp.json"
  marker="$tmp/$case_name.tools-call"
  permission_mode=bypassPermissions
  [ "$deny_bash" = 0 ] || permission_mode=dontAsk
  : >"$out"
  chmod 600 "$out"
  write_settings "$settings" "$deny_bash"
  write_mcp_config "$mcp" "$validation"
  ARK_HOOK_FIXTURE_OUT="$out" ARK_MCP_CALL_MARKER="$marker" CLAUDE_CONFIG_DIR="$config_dir" \
    "$binary" -p "$prompt" --tools "$tools" --permission-mode "$permission_mode" \
    --settings "$settings" --setting-sources user --strict-mcp-config --mcp-config "$mcp" \
    --no-session-persistence --debug-file "$debug" >"$transcript" 2>"$tmp/$case_name.stderr"
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
  [ -s "$source" ] || fail "$name did not produce a PostToolUseFailure capture"
  jq -e 'type == "object" and .hook_event_name == "PostToolUseFailure"' "$source" >/dev/null \
    || fail "$name produced an invalid hook envelope"
  cp "$source" "$destination"
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
} >"$provenance"
chmod 644 "$provenance"

printf 'collector completed mode=%s version=%s\n' "$MODE" "$version"
