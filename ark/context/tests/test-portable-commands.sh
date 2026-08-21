#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/context/tests/test-helper.sh"

# Replace quoted shell literals and comments with a marker before looking for
# commands. Command substitutions inside double quotes remain visible.
sanitize_shell() {
  awk '
    function literal_token(value) {
      return value ~ /^[[:alnum:]_.\/-]+$/ ? value : "q"
    }
    BEGIN { state = "plain"; return_state = ""; depth = 0 }
    {
      output = ""
      previous = ""
      for (position = 1; position <= length($0); position++) {
        character = substr($0, position, 1)
        following = substr($0, position + 1, 1)
        if (state == "single") {
          if (character == "\047") {
            output = output literal_token(quoted)
            state = return_state
          } else {
            quoted = quoted character
          }
          continue
        }
        if (state == "double") {
          if (character == "\\") { quoted = quoted following; position++; continue }
          if (character == "\"") {
            output = output literal_token(quoted)
            state = return_state
            continue
          }
          if (character == "$" && following == "(") {
            output = output literal_token(quoted) "$("
            quoted = ""
            position++
            state = "substitution"
            depth = 1
          } else {
            quoted = quoted character
          }
          continue
        }
        if (state == "sub_single") {
          if (character == "\047") {
            output = output literal_token(quoted)
            state = "substitution"
          } else {
            quoted = quoted character
          }
          continue
        }
        if (state == "sub_double") {
          if (character == "\\") { quoted = quoted following; position++; continue }
          if (character == "\"") {
            output = output literal_token(quoted)
            state = "substitution"
          } else {
            quoted = quoted character
          }
          continue
        }
        if (state == "substitution") {
          if (character == "\047") { quoted = ""; state = "sub_single"; continue }
          if (character == "\"") { quoted = ""; state = "sub_double"; continue }
          if (character == "(") depth++
          if (character == ")") {
            depth--
            if (depth == 0) { output = output character; state = "double"; continue }
          }
          output = output character
          continue
        }
        if (character == "\047") {
          quoted = ""
          return_state = "plain"
          state = "single"
        } else if (character == "\"") {
          quoted = ""
          return_state = "plain"
          state = "double"
        } else if (character == "#" && (previous == "" || previous ~ /[[:space:];&|(){}]/)) {
          break
        } else if (character == "\\") {
          output = output "q"
          position++
        } else {
          output = output character
        }
        previous = character
      }
      print output
    }
  ' "$1"
}

command_pattern() {
  case "$1" in
    stat) printf '%s' 'stat[[:space:]]+-c([[:space:]]|$)' ;;
    readlink) printf '%s' 'readlink[[:space:]]+-f([[:space:]]|$)' ;;
    *) printf '%s([[:space:]]|$)' "$1" ;;
  esac
}

has_portable_stat_fallback() {
  fallback_start=$2
  fallback_end=$((fallback_start + 2))
  sed -n "${fallback_start},${fallback_end}p" "$1" \
    | grep -E 'stat[[:space:]]+-f([[:space:]]|$)' >/dev/null 2>&1
}

is_capability_exception() {
  exception_file=$1
  exception_line=$2
  exception_command=$3
  exception_source=$4
  case "$exception_command" in
    stat)
      has_portable_stat_fallback "$exception_file" "$exception_line"
      ;;
    sha256sum)
      [ "$exception_line" -gt 1 ] || return 1
      previous_line=$(sed -n "$((exception_line - 1))p" "$exception_file")
      following_lines=$(sed -n "$((exception_line + 1)),$((exception_line + 6))p" "$exception_file")
      printf '%s\n' "$previous_line" | grep -E 'command -v sha256sum' >/dev/null 2>&1 \
        && printf '%s\n' "$following_lines" | grep -E 'command -v shasum' >/dev/null 2>&1 \
        && printf '%s\n' "$following_lines" | grep -E 'command -v openssl' >/dev/null 2>&1
      ;;
    timeout)
      [ "$exception_file" = "$ROOT/ark/context/tests/test-summarize-errors.sh" ] \
        && [ "$exception_source" = '  timeout) exit 28 ;;' ]
      ;;
    *) return 1 ;;
  esac
}

scan_file() {
  scan_target=$1
  scan_output=$2
  sanitized_output=${scan_output}.sanitized
  command_prefix='(^|[;&|({])[[:space:]]*((if|then|elif|else|while|until|do|!)[[:space:]]+)?([[:alpha:]_][[:alnum:]_]*=([^[:space:];&|()]|q)+[[:space:]]+)*'
  simple_commands='(rg|timeout|sha256sum|realpath|flock|xxd|stdbuf|setsid)([[:space:]]|$)'
  option_commands='(readlink[[:space:]]+-f|stat[[:space:]]+-c)([[:space:]]|$)'
  all_commands="(${simple_commands}|${option_commands})"
  absolute_interpreters='(/bin/zsh|/usr/bin/zsh|/usr/local/bin/[^[:space:];&|()]+|/opt/homebrew/bin/[^[:space:];&|()]+)([[:space:]]|$)'
  environment_prefix='env[[:space:]]+(((-i|--ignore-environment)[[:space:]]+|(-u|--unset)[[:space:]]+[^[:space:]]+[[:space:]]+|--unset=[^[:space:]]+[[:space:]]+|[[:alpha:]_][[:alnum:]_]*=([^[:space:];&|()]|q)+[[:space:]]+)*)'
  : >"$scan_output"
  sanitize_shell "$scan_target" >"$sanitized_output" || return 2
  grep -nE "${command_prefix}(${all_commands}|${absolute_interpreters})|${command_prefix}(command|exec)[[:space:]]+(--[[:space:]]+)?(${all_commands}|${absolute_interpreters})|${command_prefix}${environment_prefix}(${all_commands}|${absolute_interpreters})|[$][(][[:space:]]*(rg|timeout|sha256sum|realpath|flock|xxd|stdbuf|setsid)[)]" \
    "$sanitized_output" >"${sanitized_output}.candidates" || :
  while IFS=: read -r scan_line scan_source; do
    if printf '%s\n' "$scan_source" | grep -E "${command_prefix}${absolute_interpreters}" >/dev/null 2>&1 \
      || printf '%s\n' "$scan_source" | grep -E "${command_prefix}(command|exec)[[:space:]]+(--[[:space:]]+)?${absolute_interpreters}" >/dev/null 2>&1 \
      || printf '%s\n' "$scan_source" | grep -E "${command_prefix}${environment_prefix}${absolute_interpreters}" >/dev/null 2>&1; then
      printf '%s:%s: absolute interpreter path\n' "$scan_target" "$scan_line" >>"$scan_output"
    fi
    for scan_command in rg timeout sha256sum realpath readlink stat flock xxd stdbuf setsid; do
      scan_pattern=$(command_pattern "$scan_command")
      if printf '%s\n' "$scan_source" | grep -E "${command_prefix}${scan_pattern}" >/dev/null 2>&1 \
        || printf '%s\n' "$scan_source" | grep -E "${command_prefix}(command|exec)[[:space:]]+(--[[:space:]]+)?${scan_pattern}" >/dev/null 2>&1 \
        || printf '%s\n' "$scan_source" | grep -E "${command_prefix}${environment_prefix}${scan_pattern}" >/dev/null 2>&1 \
        || printf '%s\n' "$scan_source" | grep -E "[$][(][[:space:]]*${scan_command}[)]" >/dev/null 2>&1; then
        original_source=$(sed -n "${scan_line}p" "$scan_target")
        if ! is_capability_exception "$scan_target" "$scan_line" "$scan_command" "$original_source"; then
          printf '%s:%s: %s\n' "$scan_target" "$scan_line" "$scan_command" >>"$scan_output"
        fi
      fi
    done
  done <"${sanitized_output}.candidates"
  [ ! -s "$scan_output" ]
}

# POSIX does not require sed replacement strings to interpret \t as a tab.
# Parse substitution commands directly so the guard is independent of the sed
# implementation running this test and does not flag \t in patterns/comments.
scan_sed_replacement_tabs() {
  sed_scan_target=$1
  sed_scan_output=$2
  awk '
    function is_escaped(value, position, count, cursor) {
      count = 0
      for (cursor = position - 1; cursor >= 1 && substr(value, cursor, 1) == "\\"; cursor--) count++
      return count % 2
    }
    function substitution_has_tab(arguments, position, delimiter, cursor, pattern_end, character) {
      for (position = 1; position < length(arguments); position++) {
        if (substr(arguments, position, 1) != "s") continue
        delimiter = substr(arguments, position + 1, 1)
        if (delimiter ~ /[[:alnum:][:space:]\\]/) continue
        pattern_end = 0
        for (cursor = position + 2; cursor <= length(arguments); cursor++) {
          character = substr(arguments, cursor, 1)
          if (character == delimiter && !is_escaped(arguments, cursor)) {
            pattern_end = cursor
            break
          }
        }
        if (!pattern_end) continue
        for (cursor = pattern_end + 1; cursor <= length(arguments); cursor++) {
          character = substr(arguments, cursor, 1)
          if (character == delimiter && !is_escaped(arguments, cursor)) break
          if (character == "\\" && substr(arguments, cursor + 1, 1) == "t" \
              && !is_escaped(arguments, cursor)) return 1
        }
      }
      return 0
    }
    function sed_arguments_start(value, start, position, state, character, previous, following) {
      state = "plain"
      for (position = start; position <= length(value); position++) {
        character = substr(value, position, 1)
        if (state == "single") {
          if (character == "\047") state = "plain"
          continue
        }
        if (state == "double") {
          if (character == "\\") { position++; continue }
          if (character == "\"") state = "plain"
          continue
        }
        if (character == "\047") { state = "single"; continue }
        if (character == "\"") { state = "double"; continue }
        previous = position == 1 ? "" : substr(value, position - 1, 1)
        if (character == "#" && (previous == "" || previous ~ /[;&|(){}[:space:]]/)) return 0
        following = substr(value, position + 3, 1)
        if (substr(value, position, 3) == "sed" \
            && (previous == "" || previous ~ /[;&|(){}[:space:]]/) \
            && following ~ /[[:space:]]/) return position + 4
        if (character == "\\") position++
      }
      return 0
    }
    function shell_command_end(value, start, position, state, character) {
      state = "plain"
      for (position = start; position <= length(value); position++) {
        character = substr(value, position, 1)
        if (state == "single") {
          if (character == "\047") state = "plain"
          continue
        }
        if (state == "double") {
          if (character == "\\") { position++; continue }
          if (character == "\"") state = "plain"
          continue
        }
        if (character == "\047") { state = "single"; continue }
        if (character == "\"") { state = "double"; continue }
        if (character ~ /[;&|]/) return position
        if (character == "\\") position++
      }
      return length(value) + 1
    }
    {
      search_start = 1
      while ((arguments_start = sed_arguments_start($0, search_start)) > 0) {
        command_end = shell_command_end($0, arguments_start)
        arguments = substr($0, arguments_start, command_end - arguments_start)
        if (substitution_has_tab(arguments)) {
          print FILENAME ":" FNR ": sed replacement uses \\t"
          next
        }
        search_start = command_end + 1
      }
    }
  ' "$sed_scan_target" >"$sed_scan_output"
  [ ! -s "$sed_scan_output" ]
}

violations="$TEST_TMP/violations"
: >"$violations"
find "$ROOT/ark/context" -type f -name '*.sh' -print | sort | while IFS= read -r shell_file; do
  file_violations="$TEST_TMP/file-violations"
  if ! scan_file "$shell_file" "$file_violations"; then
    cat "$file_violations" >>"$violations"
  fi
  sed_violations="$TEST_TMP/sed-violations"
  if ! scan_sed_replacement_tabs "$shell_file" "$sed_violations"; then
    cat "$sed_violations" >>"$violations"
  fi
done
TESTS=$((TESTS + 1))
if [ ! -s "$violations" ]; then
  PASSES=$((PASSES + 1))
else
  CASE_STDERR=$violations
  test_fail "ark/context contains a non-portable command"
fi

# Exercise every prohibited command spelling so changes cannot silently make
# the scanner accept direct invocation. Names are assembled to keep this test
# itself subject to the same literal filtering as every other shell file.
name_rg=r; name_rg=${name_rg}g
name_timeout=time; name_timeout=${name_timeout}out
name_sha=sha256; name_sha=${name_sha}sum
name_real=real; name_real=${name_real}path
name_read=read; name_read=${name_read}link
name_stat=st; name_stat=${name_stat}at
name_flock=fl; name_flock=${name_flock}ock
name_xxd=x; name_xxd=${name_xxd}xd
name_stdbuf=std; name_stdbuf=${name_stdbuf}buf
name_setsid=set; name_setsid=${name_setsid}sid
path_zsh=/usr/bin/z; path_zsh=${path_zsh}sh
path_local=/usr/local/bin/py; path_local=${path_local}thon3
path_homebrew=/opt/homebrew/bin/ba; path_homebrew=${path_homebrew}sh

for prohibited in \
  "$name_rg -n file" \
  "$name_timeout 5 command" \
  "$name_sha file" \
  "$name_real file" \
  "$name_read -f file" \
  "$name_stat -c %s file" \
  "$name_flock file command" \
  "$name_xxd file" \
  "$name_stdbuf command" \
  "$name_setsid command"; do
  printf '%s\n' "$prohibited" >"$TEST_TMP/prohibited.sh"
  run_case scan_file "$TEST_TMP/prohibited.sh" "$TEST_TMP/prohibited.out"
  assert_eq "guard rejects $prohibited" 1 "$CASE_STATUS"
done

printf 'value=$(%s)\n' "$name_rg" >"$TEST_TMP/prohibited.sh"
run_case scan_file "$TEST_TMP/prohibited.sh" "$TEST_TMP/prohibited.out"
assert_eq "guard rejects no-argument command substitution" 1 "$CASE_STATUS"

printf 'printf x | %s file\n' "$name_timeout" >"$TEST_TMP/prohibited.sh"
run_case scan_file "$TEST_TMP/prohibited.sh" "$TEST_TMP/prohibited.out"
assert_eq "guard rejects pipeline command" 1 "$CASE_STATUS"

printf 'env MODE=test %s file\n' "$name_sha" >"$TEST_TMP/prohibited.sh"
run_case scan_file "$TEST_TMP/prohibited.sh" "$TEST_TMP/prohibited.out"
assert_eq "guard rejects env-launched command" 1 "$CASE_STATUS"

printf '"%s" file\n' "$name_real" >"$TEST_TMP/prohibited.sh"
run_case scan_file "$TEST_TMP/prohibited.sh" "$TEST_TMP/prohibited.out"
assert_eq "guard rejects quoted command name" 1 "$CASE_STATUS"

printf 'first=%s\nprintf "%s\\n" "%s"\n' \
  "'$name_flock $name_timeout $name_sha'" '%s' "$name_rg $name_real" >"$TEST_TMP/literals.sh"
run_case scan_file "$TEST_TMP/literals.sh" "$TEST_TMP/literals.out"
assert_success "guard ignores quoted literal mentions"

for absolute_interpreter in "$path_zsh" "$path_local" "$path_homebrew"; do
  printf 'env MODE=test %s script\n' "$absolute_interpreter" >"$TEST_TMP/absolute-interpreter.sh"
  run_case scan_file "$TEST_TMP/absolute-interpreter.sh" "$TEST_TMP/absolute-interpreter.out"
  assert_eq "guard rejects absolute interpreter $absolute_interpreter" 1 "$CASE_STATUS"
done

printf '%s\n' '#!/bin/zsh' 'printf portable' >"$TEST_TMP/shebang.sh"
run_case scan_file "$TEST_TMP/shebang.sh" "$TEST_TMP/shebang.out"
assert_success "absolute interpreter guard ignores shebang"

printf '%s\n' '/bin/bash script' '/bin/sh script' >"$TEST_TMP/allowed-system-shells.sh"
run_case scan_file "$TEST_TMP/allowed-system-shells.sh" "$TEST_TMP/allowed-system-shells.out"
assert_success "absolute interpreter guard allows system bash and sh"

tab_escape='\'
tab_escape=${tab_escape}t
printf "sed 's/Safe goal/Safe%sgoal/' file\n" "$tab_escape" >"$TEST_TMP/nonportable-sed.sh"
run_case scan_sed_replacement_tabs "$TEST_TMP/nonportable-sed.sh" "$TEST_TMP/nonportable-sed.out"
assert_eq "guard rejects sed replacement tab escape" 1 "$CASE_STATUS"

printf "# sed 's/Safe goal/Safe%sgoal/' is documentation\n" "$tab_escape" \
  >"$TEST_TMP/portable-sed-mentions.sh"
printf "printf \"sed 's/Safe goal/Safe%%sgoal/'\" value\n" \
  >>"$TEST_TMP/portable-sed-mentions.sh"
printf "sed 's/Safe%sgoal/Safe goal/' file\n" "$tab_escape" \
  >>"$TEST_TMP/portable-sed-mentions.sh"
run_case scan_sed_replacement_tabs "$TEST_TMP/portable-sed-mentions.sh" "$TEST_TMP/portable-sed-mentions.out"
assert_success "sed replacement guard ignores comments, literals, and patterns"

finish_tests "portable command tests"
