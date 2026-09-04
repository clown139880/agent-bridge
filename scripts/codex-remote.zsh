# Transparent local-first Codex launcher for Agent Bridge.
# Oh My Zsh loads this file through ~/.oh-my-zsh/custom/agent-bridge-codex.zsh.

function codex() {
  local codex_real="${CODEX_REAL_COMMAND:-${commands[codex]:-codex}}"
  local app_server_url="${CODEX_APP_SERVER_URL:-ws://127.0.0.1:4500}"
  local arg
  local has_explicit_cwd=false

  for arg in "$@"; do
    case "$arg" in
      -C|--cd|--cd=*)
        has_explicit_cwd=true
        break
        ;;
    esac
  done

  case "${1:-}" in
    app|app-server|apply|archive|cloud|completion|debug|delete|doctor|exec|exec-server|execpolicy|features|login|logout|mcp|mcp-server|plugin|remote-control|sandbox|unarchive|update|help)
      command "$codex_real" "$@"
      ;;
    *)
      if [[ "$has_explicit_cwd" == true ]]; then
        command "$codex_real" --remote "$app_server_url" "$@"
      else
        command "$codex_real" --remote "$app_server_url" --cd "$PWD" "$@"
      fi
      ;;
  esac
}
