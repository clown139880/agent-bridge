#!/usr/bin/env bash
# Put one secret into OpenBao (docs/secrets-design.zh.md §5) without it passing through a terminal
# echo, a command line or an LLM's context. Adds or updates one key; other keys at the path stay.
#
#   scripts/secret-put.sh shared/tokensapi TOKENSAPI_API_KEY            # you type it (hidden)
#   scripts/secret-put.sh shared/x API_KEY --from-env-file /path/.env SRC_VAR   # copy an existing value
#   some-command | scripts/secret-put.sh shared/x API_KEY              # an agent stores a value it generated
#
# Writes with the secrets-writer token (create/update under kv/shared/*, no delete, no reads of values).
# Prints only the path, the key name and the value's length.
set -euo pipefail
path=${1:?usage: secret-put.sh <path under kv, e.g. shared/name> <KEY> [--from-env-file FILE VAR]}
key=${2:?usage: secret-put.sh <path> <KEY> [--from-env-file FILE VAR]}
[[ $path =~ ^shared/[a-z0-9][a-z0-9-]*$ ]] || { echo "path must be shared/<name>" >&2; exit 2; }
[[ $key =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "KEY must be an environment-style name" >&2; exit 2; }
token_file=${OPENBAO_WRITER_TOKEN_FILE:-/etc/agent-bridge/openbao-secrets-writer.token}
export BAO_ADDR=${OPENBAO_ADDR:-http://127.0.0.1:8200}

if [[ ${3:-} == --from-env-file ]]; then
  file=${4:?--from-env-file needs FILE VAR}; var=${5:?--from-env-file needs FILE VAR}
  value=$(python3 - "$file" "$var" <<'PY'
import sys
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if line.startswith("export "): line = line[7:]
    name, sep, val = line.partition("=")
    if sep and name.strip() == sys.argv[2]:
        print(val.strip().strip("'\""), end=""); break
PY
)
elif [[ -t 0 ]]; then
  read -rsp "$key (hidden): " value; echo >&2
else
  value=$(cat)
fi
value=${value%$'\n'}
[[ -n $value ]] || { echo "empty value; nothing stored" >&2; exit 1; }

BAO_TOKEN=$(<"$token_file") || { echo "cannot read $token_file" >&2; exit 1; }
export BAO_TOKEN
# patch keeps the other keys at the path; a new path needs put.
if bao kv metadata get -mount=kv "$path" >/dev/null 2>&1; then op=patch; else op=put; fi
printf '{"%s": %s}' "$key" "$(printf '%s' "$value" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
  | bao kv "$op" -mount=kv "$path" - >/dev/null
echo "stored kv/$path#$key (${#value} chars). Record it in agent-skills secrets/inventory.yaml."
