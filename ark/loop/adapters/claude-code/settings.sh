#!/usr/bin/env bash

CLAUDE_LOOP_HOOK_JSON='{"hooks":[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR\"/ark/loop/adapters/claude-code/post-tool-batch.sh"}]}'

claude_settings_error() {
  printf '%s\n' "$*" >&2
  return 1
}

claude_settings_validate_schema() {
  command -v jq >/dev/null 2>&1 || { claude_settings_error "jq command unavailable"; return 1; }
  jq -e '
    type == "object" and
    ((has("permissions") | not) or
      (.permissions | type == "object" and
        ((has("deny") | not) or (.deny | type == "array" and all(.[]; type == "string"))))) and
    ((has("hooks") | not) or
      (.hooks | type == "object" and
        ((has("PostToolBatch") | not) or (.PostToolBatch | type == "array"))))
  ' "$1" >/dev/null 2>&1 || { claude_settings_error "invalid Claude settings schema"; return 1; }
}

claude_json_property_range() {
  local object_start=$1
  local key=$2
  LC_ALL=C awk -v object_start="$object_start" -v wanted="$key" '
    { if (NR > 1) text = text "\n"; text = text $0 }
    function ws(c) { return c == " " || c == "\t" || c == "\r" || c == "\n" }
    function skipws(p, c) { while (p <= length(text)) { c=substr(text,p,1); if (!ws(c)) break; p++ } return p }
    function stringend(p, q, c, esc) {
      esc=0
      for (q=p+1; q<=length(text); q++) {
        c=substr(text,q,1)
        if (esc) { esc=0; continue }
        if (c == "\\") { esc=1; continue }
        if (c == "\"") return q
      }
      return 0
    }
    function valueend(p, q, c, closing, depth, e) {
      c=substr(text,p,1)
      if (c == "\"") return stringend(p)
      if (c == "{" || c == "[") {
        closing=(c == "{" ? "}" : "]"); depth=1
        for (q=p+1; q<=length(text); q++) {
          c=substr(text,q,1)
          if (c == "\"") { e=stringend(q); if (!e) return 0; q=e; continue }
          if (c == substr(text,p,1)) depth++
          else if (c == closing) { depth--; if (depth == 0) return q }
        }
        return 0
      }
      q=p
      while (q<=length(text) && substr(text,q,1) != "," && substr(text,q,1) != "}") q++
      q--
      while (q>=p && ws(substr(text,q,1))) q--
      return q
    }
    END {
      p=object_start+1
      while (p<=length(text)) {
        p=skipws(p)
        if (substr(text,p,1)==",") { p++; continue }
        if (substr(text,p,1)=="}") exit
        if (substr(text,p,1)!="\"") exit
        ks=p; ke=stringend(ks); if (!ke) exit
        name=substr(text,ks+1,ke-ks-1)
        p=skipws(ke+1); if (substr(text,p,1)!=":") exit
        vs=skipws(p+1); ve=valueend(vs); if (!ve) exit
        if (name==wanted) { print ks, ke, vs, ve; exit }
        p=ve+1
      }
    }
  '
}

claude_json_value_end() {
  local start=$1
  LC_ALL=C awk -v start="$start" '
    { if (NR > 1) text = text "\n"; text = text $0 }
    function stringend(p,q,c,e){e=0;for(q=p+1;q<=length(text);q++){c=substr(text,q,1);if(e){e=0;continue}if(c=="\\"){e=1;continue}if(c=="\"")return q}return 0}
    END { opening=substr(text,start,1); closing=(opening=="{"?"}":"]"); depth=1; for(i=start+1;i<=length(text);i++){c=substr(text,i,1);if(c=="\""){i=stringend(i);continue}if(c==opening)depth++;else if(c==closing){depth--;if(depth==0){print i;exit}}} }
  '
}

claude_json_array_item_range() {
  local array_start=$1
  local wanted_index=$2
  LC_ALL=C awk -v array_start="$array_start" -v wanted="$wanted_index" '
    { if (NR > 1) text = text "\n"; text = text $0 }
    function ws(c){return c==" "||c=="\t"||c=="\r"||c=="\n"}
    function skipws(p){while(p<=length(text)&&ws(substr(text,p,1)))p++;return p}
    function stringend(p,q,c,e){e=0;for(q=p+1;q<=length(text);q++){c=substr(text,q,1);if(e){e=0;continue}if(c=="\\"){e=1;continue}if(c=="\"")return q}return 0}
    function valueend(p,q,c,opening,closing,depth){c=substr(text,p,1);if(c=="\"")return stringend(p);if(c=="{"||c=="["){opening=c;closing=(c=="{"?"}":"]");depth=1;for(q=p+1;q<=length(text);q++){c=substr(text,q,1);if(c=="\""){q=stringend(q);continue}if(c==opening)depth++;else if(c==closing){depth--;if(depth==0)return q}}}q=p;while(q<=length(text)&&substr(text,q,1)!=","&&substr(text,q,1)!="]")q++;q--;while(q>=p&&ws(substr(text,q,1)))q--;return q}
    END { p=array_start+1; idx=0; while(p<=length(text)){p=skipws(p);if(substr(text,p,1)==","){p++;continue}if(substr(text,p,1)=="]")exit;vs=p;ve=valueend(vs);if(idx==wanted){print vs,ve;exit}idx++;p=ve+1} }
  '
}

claude_content_read() {
  local file=$1
  CLAUDE_CONTENT=$(command cat "$file"; printf '\034') || return 1
  CLAUDE_CONTENT=${CLAUDE_CONTENT%?}
}

claude_content_property() {
  printf '%s' "$CLAUDE_CONTENT" | claude_json_property_range "$1" "$2"
}

claude_content_container_end() {
  printf '%s' "$CLAUDE_CONTENT" | claude_json_value_end "$1"
}

claude_content_insert() {
  local position=$1
  local fragment=$2
  local prefix suffix LC_ALL=C
  prefix=${CLAUDE_CONTENT:0:$((position - 1))}
  suffix=${CLAUDE_CONTENT:$((position - 1))}
  CLAUDE_CONTENT="$prefix$fragment$suffix"
}

claude_content_add_to_container() {
  local start=$1
  local fragment=$2
  local end inner compact separator LC_ALL=C
  end=$(claude_content_container_end "$start") || return 1
  [ -n "$end" ] || return 1
  inner=${CLAUDE_CONTENT:$start:$((end - start - 1))}
  compact=$(printf '%s' "$inner" | tr -d ' \t\r\n')
  if [ -n "$compact" ]; then separator=,; else separator=; fi
  claude_content_insert "$end" "$separator$fragment"
}

claude_content_remove_value() {
  local start=$1
  local end=$2
  local container_start=$3
  local before after char remove_start remove_end prefix suffix LC_ALL=C
  before=$((start - 1))
  while [ "$before" -gt "$container_start" ]; do
    char=${CLAUDE_CONTENT:$((before - 1)):1}
    case "$char" in ' '|$'\t'|$'\r'|$'\n') before=$((before - 1)); continue ;; esac
    break
  done
  if [ "${CLAUDE_CONTENT:$((before - 1)):1}" = , ]; then
    remove_start=$before
    remove_end=$end
  else
    after=$((end + 1))
    while [ "$after" -le "${#CLAUDE_CONTENT}" ]; do
      char=${CLAUDE_CONTENT:$((after - 1)):1}
      case "$char" in ' '|$'\t'|$'\r'|$'\n') after=$((after + 1)); continue ;; esac
      break
    done
    if [ "${CLAUDE_CONTENT:$((after - 1)):1}" = , ]; then after=$((after + 1)); fi
    remove_start=$start
    remove_end=$((after - 1))
  fi
  prefix=${CLAUDE_CONTENT:0:$((remove_start - 1))}
  suffix=${CLAUDE_CONTENT:$remove_end}
  CLAUDE_CONTENT="$prefix$suffix"
}

claude_manifest_add_string() {
  CLAUDE_ENTRIES=$(printf '%s' "$CLAUDE_ENTRIES" | jq --arg path "$1" --arg value "$2" \
    '. + [{path:$path,value:$value,abandoned:false}]') || return 1
}

claude_manifest_add_json() {
  CLAUDE_ENTRIES=$(printf '%s' "$CLAUDE_ENTRIES" | jq --arg path "$1" --argjson value "$2" \
    '. + [{path:$path,value:$value,abandoned:false}]') || return 1
}

claude_settings_exact_ignore() {
  local repo=$1
  local path=$2
  local output metadata source pattern
  output=$(git -C "$repo" check-ignore -v --no-index -- "$path" 2>/dev/null) \
    || { claude_settings_error "required exact ignore missing"; return 1; }
  metadata=${output%%$'\t'*}
  source=${metadata%%:*}
  pattern=${metadata##*:}
  [ "$source" = .gitignore ] && [ "$pattern" = "$path" ] \
    || { claude_settings_error "required exact ignore missing"; return 1; }
  git -C "$repo" ls-files --error-unmatch -- .gitignore >/dev/null 2>&1 \
    || { claude_settings_error "required exact ignore missing"; return 1; }
}

claude_settings_preflight() {
  local repo=$1
  local state=$2
  local canonical settings tmp manifest manifest_new path
  canonical=$(loop_resolve_repo "$repo") || return 1
  [ "$canonical" = "$repo" ] || { claude_settings_error "unsafe repo path"; return 1; }
  loop_validate_repo_path "$repo/.claude" directory required || return 1
  loop_validate_xdg_dir "$state" || return 1
  settings="$repo/.claude/settings.local.json"
  tmp="$repo/.claude/settings.local.json.ark-loop-tmp"
  manifest="$state/settings-ownership.json"
  manifest_new="$state/settings-ownership.json.new"
  loop_validate_repo_path "$settings" file optional || return 1
  loop_validate_repo_path "$tmp" file optional || return 1
  if [ -e "$manifest" ] || [ -L "$manifest" ]; then loop_validate_xdg_file "$manifest" || return 1; fi
  if [ -e "$manifest_new" ] || [ -L "$manifest_new" ]; then loop_validate_xdg_file "$manifest_new" || return 1; fi
  for path in .claude/settings.local.json .claude/settings.local.json.ark-loop-tmp; do
    if git -C "$repo" ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
      claude_settings_error "tracked settings path"
      return 1
    fi
    claude_settings_exact_ignore "$repo" "$path" || return 1
  done
  if [ -f "$tmp" ]; then command rm -f "$tmp" || return 1; fi
}

claude_settings_inject() {
  local repo=${1:-}
  local state=${2:-}
  local settings tmp manifest manifest_new settings_existed mode root range permissions_start deny_start hooks_start batch_start tool
  command -v jq >/dev/null 2>&1 || { claude_settings_error "jq command unavailable"; return 1; }
  settings="$repo/.claude/settings.local.json"
  tmp="$repo/.claude/settings.local.json.ark-loop-tmp"
  manifest="$state/settings-ownership.json"
  manifest_new="$state/settings-ownership.json.new"
  claude_settings_preflight "$repo" "$state" || return 1
  if [ -e "$manifest" ] || [ -L "$manifest" ]; then loop_validate_xdg_file "$manifest" || return 1; return 0; fi

  if [ -e "$settings" ] || [ -L "$settings" ]; then
    loop_validate_repo_path "$settings" file required || return 1
    claude_settings_validate_schema "$settings" || return 1
    settings_existed=true
    mode=$(loop_stat "$settings" | awk '{print $2}') || return 1
    [ -n "$mode" ] || return 1
    claude_content_read "$settings" || return 1
  else
    settings_existed=false
    mode=600
    CLAUDE_CONTENT='{}'
  fi
  CLAUDE_ENTRIES='[]'
  root=$(printf '%s' "$CLAUDE_CONTENT" | LC_ALL=C awk '{if(NR>1)s=s"\n";s=s$0}END{for(i=1;i<=length(s);i++)if(substr(s,i,1)=="{"){print i;exit}}')
  [ -n "$root" ] || return 1

  if ! printf '%s' "$CLAUDE_CONTENT" | jq -e 'has("permissions")' >/dev/null; then
    claude_content_add_to_container "$root" '"permissions"                   :{"deny":["TodoWrite","TaskCreate","TaskUpdate"]}' || return 1
    for tool in TodoWrite TaskCreate TaskUpdate; do claude_manifest_add_string permissions/deny "$tool" || return 1; done
  else
    range=$(claude_content_property "$root" permissions) || return 1
    set -- $range; permissions_start=$3
    if ! printf '%s' "$CLAUDE_CONTENT" | jq -e '.permissions | has("deny")' >/dev/null; then
      claude_content_add_to_container "$permissions_start" '"deny"                 :["TodoWrite","TaskCreate","TaskUpdate"]' || return 1
      for tool in TodoWrite TaskCreate TaskUpdate; do claude_manifest_add_string permissions/deny "$tool" || return 1; done
    else
      range=$(claude_content_property "$permissions_start" deny) || return 1
      set -- $range; deny_start=$3
      for tool in TodoWrite TaskCreate TaskUpdate; do
        if ! printf '%s' "$CLAUDE_CONTENT" | jq -e --arg tool "$tool" '.permissions.deny | index($tool) != null' >/dev/null; then
          claude_content_add_to_container "$deny_start" "\"$tool\"" || return 1
          claude_manifest_add_string permissions/deny "$tool" || return 1
        fi
      done
    fi
  fi

  if ! printf '%s' "$CLAUDE_CONTENT" | jq -e 'has("hooks")' >/dev/null; then
    claude_content_add_to_container "$root" "\"hooks\"                   :{\"PostToolBatch\":[${CLAUDE_LOOP_HOOK_JSON}]}" || return 1
    claude_manifest_add_json hooks/PostToolBatch "$CLAUDE_LOOP_HOOK_JSON" || return 1
  else
    range=$(claude_content_property "$root" hooks) || return 1
    set -- $range; hooks_start=$3
    if ! printf '%s' "$CLAUDE_CONTENT" | jq -e '.hooks | has("PostToolBatch")' >/dev/null; then
      claude_content_add_to_container "$hooks_start" "\"PostToolBatch\"                 :[${CLAUDE_LOOP_HOOK_JSON}]" || return 1
      claude_manifest_add_json hooks/PostToolBatch "$CLAUDE_LOOP_HOOK_JSON" || return 1
    elif ! printf '%s' "$CLAUDE_CONTENT" | jq -e --argjson hook "$CLAUDE_LOOP_HOOK_JSON" '.hooks.PostToolBatch | index($hook) != null' >/dev/null; then
      range=$(claude_content_property "$hooks_start" PostToolBatch) || return 1
      set -- $range; batch_start=$3
      claude_content_add_to_container "$batch_start" "$CLAUDE_LOOP_HOOK_JSON" || return 1
      claude_manifest_add_json hooks/PostToolBatch "$CLAUDE_LOOP_HOOK_JSON" || return 1
    fi
  fi

  printf '%s' "$CLAUDE_CONTENT" | jq -e . >/dev/null 2>&1 || return 1
  [ "$(printf '%s' "$CLAUDE_ENTRIES" | jq 'length')" -gt 0 ] || return 0
  if [ -e "$manifest_new" ] || [ -L "$manifest_new" ]; then loop_validate_xdg_file "$manifest_new" || return 1; fi
  jq -n --argjson existed "$settings_existed" --argjson entries "$CLAUDE_ENTRIES" \
    '{schema_version:1,settings_existed:$existed,entries:$entries}' >"$manifest_new" || return 1
  chmod 600 "$manifest_new" || return 1
  loop_validate_xdg_file "$manifest_new" || return 1
  command mv "$manifest_new" "$manifest" || return 1

  if [ -e "$tmp" ] || [ -L "$tmp" ]; then loop_validate_repo_path "$tmp" file required || return 1; fi
  old_umask=$(umask); umask 077
  printf '%s' "$CLAUDE_CONTENT" >"$tmp"
  write_status=$?
  umask "$old_umask"
  [ "$write_status" -eq 0 ] || return 1
  chmod "$mode" "$tmp" || return 1
  loop_validate_repo_path "$tmp" file required || return 1
  command mv "$tmp" "$settings" || return 1
}

claude_settings_restore() {
  local repo=${1:-}
  local state=${2:-}
  local settings tmp manifest settings_existed mode entries entry path value index range root permissions_start deny_start hooks_start batch_start item_range
  local abandoned=false property_between deny_length batch_length LC_ALL=C
  command -v jq >/dev/null 2>&1 || { claude_settings_error "jq command unavailable"; return 1; }
  settings="$repo/.claude/settings.local.json"
  tmp="$repo/.claude/settings.local.json.ark-loop-tmp"
  manifest="$state/settings-ownership.json"
  claude_settings_preflight "$repo" "$state" || return 1
  [ -e "$manifest" ] || return 0
  loop_validate_xdg_file "$manifest" || return 1
  jq -e '.schema_version == 1 and (.settings_existed|type)=="boolean" and (.entries|type)=="array"' "$manifest" >/dev/null 2>&1 || return 1
  settings_existed=$(jq -r '.settings_existed' "$manifest")
  if [ ! -e "$settings" ]; then command rm -f "$manifest"; return 0; fi
  loop_validate_repo_path "$settings" file required || return 1
  claude_settings_validate_schema "$settings" || return 1
  mode=$(loop_stat "$settings" | awk '{print $2}') || return 1
  [ -n "$mode" ] || return 1
  claude_content_read "$settings" || return 1
  entries=$(jq -c '.entries | reverse[]' "$manifest") || return 1
  while IFS= read -r entry || [ -n "$entry" ]; do
    [ -n "$entry" ] || continue
    path=$(printf '%s' "$entry" | jq -r '.path') || return 1
    root=$(printf '%s' "$CLAUDE_CONTENT" | LC_ALL=C awk '{if(NR>1)s=s"\n";s=s$0}END{for(i=1;i<=length(s);i++)if(substr(s,i,1)=="{"){print i;exit}}')
    case "$path" in
      permissions/deny)
        value=$(printf '%s' "$entry" | jq -r '.value') || return 1
        index=$(printf '%s' "$CLAUDE_CONTENT" | jq -r --arg value "$value" '.permissions.deny // [] | index($value) // -1')
        [ "$index" -ge 0 ] || continue
        range=$(claude_content_property "$root" permissions); set -- $range; permissions_start=$3
        range=$(claude_content_property "$permissions_start" deny); set -- $range; deny_start=$3
        item_range=$(printf '%s' "$CLAUDE_CONTENT" | claude_json_array_item_range "$deny_start" "$index"); set -- $item_range
        claude_content_remove_value "$1" "$2" "$deny_start" || return 1
        ;;
      hooks/PostToolBatch)
        value=$(printf '%s' "$entry" | jq -c '.value') || return 1
        index=$(printf '%s' "$CLAUDE_CONTENT" | jq -r --argjson value "$value" '.hooks.PostToolBatch // [] | index($value) // -1')
        if [ "$index" -lt 0 ]; then
          batch_length=$(printf '%s' "$CLAUDE_CONTENT" | jq -r '.hooks.PostToolBatch // [] | length')
          [ "$batch_length" -eq 0 ] || abandoned=true
          continue
        fi
        range=$(claude_content_property "$root" hooks); set -- $range; hooks_start=$3
        range=$(claude_content_property "$hooks_start" PostToolBatch); set -- $range; batch_start=$3
        item_range=$(printf '%s' "$CLAUDE_CONTENT" | claude_json_array_item_range "$batch_start" "$index"); set -- $item_range
        claude_content_remove_value "$1" "$2" "$batch_start" || return 1
        ;;
    esac
  done <<EOF
$entries
EOF

  # Remove only parent properties bearing Ark's distinctive insertion spacing.
  root=$(printf '%s' "$CLAUDE_CONTENT" | LC_ALL=C awk '{if(NR>1)s=s"\n";s=s$0}END{for(i=1;i<=length(s);i++)if(substr(s,i,1)=="{"){print i;exit}}')
  range=$(claude_content_property "$root" permissions || true)
  if [ -n "$range" ]; then
    set -- $range; permissions_start=$3
    property_between=${CLAUDE_CONTENT:$2:$((permissions_start - $2 - 1))}
    deny_length=$(printf '%s' "$CLAUDE_CONTENT" | jq -r '.permissions.deny // [] | length')
    if [ "$property_between" = '                   :' ] && [ "$deny_length" -eq 0 ]; then
      claude_content_remove_value "$1" "$4" "$root"
    else
      range=$(claude_content_property "$permissions_start" deny || true)
      if [ -n "$range" ] && [ "$deny_length" -eq 0 ]; then
        set -- $range; property_between=${CLAUDE_CONTENT:$2:$(( $3 - $2 - 1 ))}
        [ "$property_between" != '                 :' ] || claude_content_remove_value "$1" "$4" "$permissions_start"
      fi
    fi
  fi
  root=$(printf '%s' "$CLAUDE_CONTENT" | LC_ALL=C awk '{if(NR>1)s=s"\n";s=s$0}END{for(i=1;i<=length(s);i++)if(substr(s,i,1)=="{"){print i;exit}}')
  range=$(claude_content_property "$root" hooks || true)
  if [ -n "$range" ]; then
    set -- $range; hooks_start=$3
    property_between=${CLAUDE_CONTENT:$2:$((hooks_start - $2 - 1))}
    batch_length=$(printf '%s' "$CLAUDE_CONTENT" | jq -r '.hooks.PostToolBatch // [] | length')
    if [ "$property_between" = '                   :' ] && [ "$batch_length" -eq 0 ]; then
      claude_content_remove_value "$1" "$4" "$root"
    else
      range=$(claude_content_property "$hooks_start" PostToolBatch || true)
      if [ -n "$range" ] && [ "$batch_length" -eq 0 ]; then
        set -- $range; property_between=${CLAUDE_CONTENT:$2:$(( $3 - $2 - 1 ))}
        [ "$property_between" != '                 :' ] || claude_content_remove_value "$1" "$4" "$hooks_start"
      fi
    fi
  fi

  printf '%s' "$CLAUDE_CONTENT" | jq -e . >/dev/null 2>&1 || return 1
  if [ "$settings_existed" = false ] && [ "$(printf '%s' "$CLAUDE_CONTENT" | jq 'length')" -eq 0 ]; then
    command rm -f "$settings"
  else
    old_umask=$(umask); umask 077
    printf '%s' "$CLAUDE_CONTENT" >"$tmp" || { umask "$old_umask"; return 1; }
    umask "$old_umask"
    chmod "$mode" "$tmp" || return 1
    command mv "$tmp" "$settings" || return 1
  fi
  if [ "$abandoned" = true ]; then
    jq '(.entries[] | select(.path == "hooks/PostToolBatch")).abandoned = true' "$manifest" >"$manifest.new" || return 1
    chmod 600 "$manifest.new" || return 1
    command mv "$manifest.new" "$manifest" || return 1
  else
    command rm -f "$manifest"
  fi
}
