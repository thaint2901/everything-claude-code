#!/usr/bin/env bash
# setup-claude.sh — end-to-end Claude Code setup: CLI + plugin + ECC + Telegram hook.
# Reads thaint-setup/.env (see .env.example) into the settings.json env block
# (allowlisted keys) and installs the clauded_plan + <plan>_clauded gateway
# helpers.  Hardcoded modules, always overwrites, user scope only.
# shellcheck shell=bash

set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────────────
readonly TAG="claude"
readonly CLAUDE_HOME="${HOME}/.claude"
# This script lives inside the ECC tree it installs from (thaint-setup/), so the
# source is simply the repo root — no clone, no fetch, no version pin. Whatever
# ref you checked out is what gets installed; git already did that work.
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly CLAUDE_INSTALL_URL="${CLAUDE_INSTALL_URL:-https://claude.ai/install.sh}"
readonly CLAUDE_PLUGIN="${CLAUDE_PLUGIN:-claude-md-management@claude-plugins-official}"
readonly CLAUDE_MARKETPLACE_SOURCE="${CLAUDE_MARKETPLACE_SOURCE:-anthropics/${CLAUDE_PLUGIN##*@}}"

# Credentials are env-only (settings.json env block, see Claude Code docs).
# Optionally provided at install time (or via thaint-setup/.env) to
# auto-populate settings.json.
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"

# ── Env file ─────────────────────────────────────────────────────────────────
# A single gitignored .env next to this script feeds the settings.json env
# block.  Only the keys in ENV_APPLY_KEYS are applied; a per-plan gateway block
# (the ANTHROPIC_* routing vars) does NOT live here — it lives in
# ~/coding_plan/<plan>.env and is sourced only by the clauded_plan helper.
readonly ENV_FILE="${SCRIPT_DIR}/.env"
readonly ENV_APPLY_KEYS=(CONTEXT7_API_KEY EXA_API_KEY FIRECRAWL_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID)

# ── Mutable state ────────────────────────────────────────────────────────────
SOURCE="$REPO_ROOT"
DRY_RUN=0
VERBOSE=0
PRUNE=0

# ── Logging ──────────────────────────────────────────────────────────────────
log()  { printf '[%s] %s\n' "$TAG" "$*"; }
warn() { printf '[%s] warn: %s\n' "$TAG" "$*" >&2; }
die()  { printf '[%s] error: %s\n' "$TAG" "$*" >&2; exit 1; }

# Run a command, honoring DRY_RUN and VERBOSE.
run() {
  if (( DRY_RUN )); then
    printf '[dry-run] %s\n' "$*"
    return 0
  fi
  if (( VERBOSE )); then
    printf '[%s] $ %s\n' "$TAG" "$*"
  fi
  "$@"
}

require_cmd() {
  local c hint
  for c in "$@"; do
    command -v "$c" >/dev/null && continue
    case "$c" in
      jq)       hint="install via: apt install -y jq  /  brew install jq" ;;
      curl)     hint="install via: apt install -y curl  /  brew install curl" ;;
      git)      hint="install via: apt install -y git  /  brew install git" ;;
      node|npm) hint="install Node.js from https://nodejs.org or via nvm" ;;
      *)        hint="" ;;
    esac
    if [[ -n "$hint" ]]; then
      die "required command missing: $c — $hint"
    else
      die "required command missing: $c"
    fi
  done
}

# ── Usage / args ─────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $0 [--dry-run] [--verbose] [-h]

End-to-end Claude Code setup. Installs (always overwrites) into ${CLAUDE_HOME}:
  claude-code CLI (if missing), skip-onboarding flag in ~/.claude.json,
  marketplace + plugin ${CLAUDE_PLUGIN} (if missing),
  agents, commands, hooks-runtime, configure-ecc, strategic-compact, telegram-hook,
  ECC statusline (.statusLine; a hand-edited value is kept as-is),
  this fork's hook-audit env defaults (ECC_DISABLED_HOOKS,
  ECC_GATEGUARD — only set if unset)
Allowlisted env from thaint-setup/.env (see .env.example) written to the
  settings.json env block: CONTEXT7_API_KEY, EXA_API_KEY, FIRECRAWL_API_KEY,
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. Per-plan ANTHROPIC gateway blocks
  (routing/model vars) live in ~/coding_plan/<plan>.env and are read only
  by the installed <plan>_clauded helpers.
Shell rc patch (.zshrc or .bashrc):
  alias clauded='claude --dangerously-skip-permissions'
  source ~/.claude/setup/clauded-plan.sh  (defines clauded_plan +
    <plan>_clauded wrappers, e.g. ocgo_clauded)
  export CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1

Installs from the ECC tree this script lives in (${REPO_ROOT}).
To install a different version, check out that ref and re-run.

Options:
  --dry-run         Print actions without executing
  --prune           Delete files in the destination that no longer exist in the
                    source (off by default: agents/ and commands/ also hold your
                    own files). Without it, such files are only listed.
  --verbose, -v     Log every command
  -h, --help        Show this help

Env overrides:
  CLAUDE_INSTALL_URL, CLAUDE_PLUGIN, CLAUDE_MARKETPLACE_SOURCE
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
EOF
}

parse_args() {
  while (( $# )); do
    case "$1" in
      --dry-run)    DRY_RUN=1; shift ;;
      --prune)      PRUNE=1; shift ;;
      --verbose|-v) VERBOSE=1; shift ;;
      -h|--help)    usage; exit 0 ;;
      *)            die "unknown arg: $1 (try --help)" ;;
    esac
  done
}

# ── Prerequisites: Claude Code CLI + plugin ──────────────────────────────────
ensure_claude_code() {
  if command -v claude >/dev/null 2>&1; then
    log "claude CLI present: $(claude --version 2>/dev/null || echo unknown)"
    return
  fi
  log "installing claude CLI from $CLAUDE_INSTALL_URL"
  require_cmd curl
  if (( DRY_RUN )); then
    printf '[dry-run] curl -fsSL %s | bash\n' "$CLAUDE_INSTALL_URL"
    return
  fi
  curl -fsSL "$CLAUDE_INSTALL_URL" | bash \
    || die "claude CLI install failed"
  command -v claude >/dev/null 2>&1 \
    || die "claude CLI not on PATH after install — open a new shell or check ~/.local/bin"
}

ensure_onboarding() {
  local config="${HOME}/.claude.json"
  if (( DRY_RUN )); then
    printf '[dry-run] patch %s (hasCompletedOnboarding=true)\n' "$config"
    return
  fi

  if [[ -f "$config" ]] && [[ "$(jq -r '.hasCompletedOnboarding // false' "$config")" == "true" ]]; then
    log "onboarding already marked complete: $config"
    return
  fi

  [[ -f "$config" ]] || printf '{}\n' > "$config"
  local tmp
  tmp="$(mktemp)"
  jq '.hasCompletedOnboarding = true' "$config" > "$tmp" \
    || die "jq failed to patch $config"
  mv "$tmp" "$config"
  log "marked onboarding complete: $config"
}

require_claude_cli() {
  command -v claude >/dev/null 2>&1 && return 0
  if (( DRY_RUN )); then
    printf '[dry-run] (skip — claude CLI not present)\n'
    return 1
  fi
  die "claude CLI missing — cannot proceed"
}

ensure_marketplace() {
  local marketplace="${CLAUDE_PLUGIN##*@}"
  require_claude_cli || return 0
  if claude plugin marketplace list 2>/dev/null | grep -Fq "$marketplace"; then
    log "marketplace already added: $marketplace"
    return
  fi
  log "adding marketplace $marketplace ($CLAUDE_MARKETPLACE_SOURCE)"
  run claude plugin marketplace add "$CLAUDE_MARKETPLACE_SOURCE"
}

ensure_plugin() {
  local plugin="$CLAUDE_PLUGIN"
  local plugin_name="${plugin%@*}"
  require_claude_cli || return 0
  if claude plugin list 2>/dev/null | grep -Fq "$plugin_name"; then
    log "plugin already installed: $plugin"
    return
  fi
  log "installing plugin $plugin"
  run claude plugin install "$plugin"
}

# ── Source description ───────────────────────────────────────────────────────
# Reports the checked-out ref for the log line. Purely informational: the tree
# is installed as-is whether or not git can name it.
describe_source() {
  git -C "$REPO_ROOT" describe --tags --always --dirty 2>/dev/null \
    || printf '%s' 'unknown ref'
}

# ── Filesystem helpers ───────────────────────────────────────────────────────
copy_dir() {
  local src="$1" dst="$2"
  [[ -d "$src" ]] || { warn "missing $src — skipped"; return; }
  run mkdir -p "$dst"
  run cp -rf "$src/." "$dst/"
  report_foreign "$src" "$dst"
}

# cp -rf overwrites but never deletes, so a file upstream removed keeps working
# forever from a stale install. These directories are a shared namespace though —
# your own agents and commands live there too — so deletion stays opt-in.
report_foreign() {
  local src="$1" dst="$2" rel
  local -a foreign=()

  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    [[ -e "$src/$rel" ]] || foreign+=("$rel")
  # `find -printf` is GNU-only; on BSD/macOS it fails, and inside a process
  # substitution that failure never reaches `set -e` — the whole report would
  # silently produce nothing. Strip the leading ./ with sed instead.
  done < <(cd "$dst" && find . -type f 2>/dev/null | sed 's|^\./||' | sort)

  (( ${#foreign[@]} )) || return 0

  if (( PRUNE )); then
    for rel in "${foreign[@]}"; do
      if (( DRY_RUN )); then
        printf '[dry-run] rm %s\n' "$dst/$rel"
      else
        run rm -f "$dst/$rel"
      fi
    done
    log "pruned ${#foreign[@]} file(s) absent from $src"
  else
    warn "${#foreign[@]} file(s) in $dst are absent from the source — pass --prune to delete:"
    for rel in "${foreign[@]}"; do
      warn "  $rel"
    done
  fi
}

# ── Installers ───────────────────────────────────────────────────────────────
# Installable directories.  Each entry is a label; the source/dest path is
# derived automatically (labels map 1:1 to directory names under $SOURCE and
# $CLAUDE_HOME, with an optional "skills/" prefix for skill entries).
readonly INSTALL_ITEMS=(
  agents
  commands
  skills/configure-ecc
  skills/strategic-compact
)

install_all_dirs() {
  local rel_path label
  for rel_path in "${INSTALL_ITEMS[@]}"; do
    label="${rel_path##*/}"       # e.g. "configure-ecc" from "skills/configure-ecc"
    log "$label"
    copy_dir "$SOURCE/$rel_path" "$CLAUDE_HOME/$rel_path"
  done
}

install_hooks_runtime() {
  log "hooks-runtime"
  [[ -f "$SOURCE/install.sh" ]] || die "hooks-runtime: $SOURCE/install.sh missing"
  require_cmd node npm
  [[ -x "$SOURCE/install.sh" ]] || run chmod +x "$SOURCE/install.sh"
  if (( DRY_RUN )); then
    printf '[dry-run] (cd %s && ./install.sh --target claude --modules hooks-runtime)\n' "$SOURCE"
  else
    ( cd "$SOURCE" && ./install.sh --target claude --modules hooks-runtime )
  fi
}

install_telegram_hook() {
  log "telegram-hook"
  require_cmd node

  local hook_dir="${CLAUDE_HOME}/scripts/hooks"
  local hook_js="${hook_dir}/telegram-notify.js"
  local settings="${CLAUDE_HOME}/settings.json"

  if (( DRY_RUN )); then
    printf '[dry-run] mkdir -p %s\n' "$hook_dir"
    printf '[dry-run] write %s (chmod 700)\n' "$hook_js"
  else
    run mkdir -p "$hook_dir"
    cp "${SCRIPT_DIR}/telegram-notify.js" "$hook_js"
    chmod 700 "$hook_js"
  fi

  patch_settings_telegram "$settings" "$hook_js"
}

# Reads thaint-setup/.env into the shell so the allowlisted keys are visible
# for patch_settings_env.  Real shell exports win over the file: `source` is
# run inside a subshell with `set -a`, so the file can only *add* a value for a
# key that is not already set in the environment.  Keys not in ENV_APPLY_KEYS
# (a per-plan ANTHROPIC_* gateway block in ~/coding_plan/*.env) are never
# loaded here — only the clauded_plan helper reads those.
load_env() {
  [[ -f "$ENV_FILE" ]] || return 0
  local bad
  bad="$(grep -vE '^[[:space:]]*(#|$)' "$ENV_FILE" | grep -vE '^[A-Za-z_][A-Za-z0-9_]*=' || true)"
  if [[ -n "$bad" ]]; then
    warn ".env has non-KEY=value lines (ignored): $(printf '%s' "$bad" | tr '\n' ' ')"
  fi
  # Parse with `source` for zsh/bash quoting fidelity (values may contain
  # spaces, ${...}, etc.), then explicitly export the allowlisted keys.  `set -a`
  # inside the subshell is not enough: `source` runs in the script's own shell,
  # and a bare KEY=value line there sets a shell variable that is never
  # exported to the jq subprocess below.
  local key
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  for key in "${ENV_APPLY_KEYS[@]}"; do
    [[ -n "${!key:-}" ]] && export "${key}=${!key}"
  done
  if (( VERBOSE )); then
    log "loaded $(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE") vars from $ENV_FILE"
  fi
}

# Applies whatever allowlisted keys are present in the environment (from
# shell exports or load_env's read of thaint-setup/.env) into settings.json's
# env block.  An unset key is left untouched — its MCP server stays disabled.
# The gateway vars are not in ENV_APPLY_KEYS and never reach settings.json.
ensure_apply_env() {
  local settings="$1"
  local -a pairs=()
  local key
  for key in "${ENV_APPLY_KEYS[@]}"; do
    [[ -n "${!key:-}" ]] || continue
    pairs+=("$key" "${!key}")
  done
  (( ${#pairs[@]} )) && patch_settings_env "$settings" "${pairs[@]}"
}

patch_settings_env() {
  local settings="$1"
  shift
  local n=$(( $# / 2 ))

  if (( DRY_RUN )); then
    printf '[dry-run] patch %s (env keys: %s)\n' "$settings" "$*"
    return
  fi

  [[ -f "$settings" ]] || printf '{}\n' > "$settings"
  local tmp
  tmp="$(mktemp)"
  # Keys and values travel as two JSON string arrays passed via --argjson, so
  # arbitrary value strings (spaces, "1e3", quotes) survive unchanged.  The
  # file must precede the jq args.
  # $@ is now an interleaved key/value list (key1 val1 key2 val2 …).  Build the
  # two JSON arrays by consuming two positional args per iteration.
  local keys values key val
  keys="["
  values="["
  while (($# >= 2)); do
    key="$1"; val="$2"; shift 2
    keys+="$(printf '%s' "$key" | jq -R .),"
    values+="$(printf '%s' "$val" | jq -R .),"
  done
  keys="${keys%,}]"
  values="${values%,}]"
  jq --argjson ks "$keys" --argjson vs "$values" '
    reduce range(0; ($ks | length)) as $i (.; .env[$ks[$i]] = $vs[$i])
  ' "$settings" > "$tmp" \
    || die "jq failed to patch env block in $settings"
  mv "$tmp" "$settings"
  log "patched settings.json env (${n} keys)"
}

patch_settings_telegram() {
  local settings="$1" hook_js="$2"

  if (( DRY_RUN )); then
    printf '[dry-run] patch %s (clean Stop, set Notification)\n' "$settings"
    return
  fi

  [[ -f "$settings" ]] || printf '{}\n' > "$settings"

  local tmp
  tmp="$(mktemp)"
  jq \
    --arg cmd "node $hook_js" \
    --arg marker "telegram-notify.js" \
    '
    .hooks //= {} |
    .hooks.Stop //= [] |
    .hooks.Notification //= [] |
    .hooks.Stop = [
      .hooks.Stop[] | select(.hooks[0].command // "" | contains($marker) | not)
    ] |
    .hooks.Notification = (
      [.hooks.Notification[] | select(.hooks[0].command // "" | contains($marker) | not)]
      + [{ matcher: "", hooks: [ { type: "command", command: $cmd, timeout: 10, async: true } ] }]
    )
    ' "$settings" > "$tmp" \
    || die "jq failed to patch $settings"
  mv "$tmp" "$settings"
  log "patched settings.json (telegram entry in Notification)"
}

# ECC hooks the shipped graph deliberately leaves out. Kept if already wired,
# never added: insaits-security is opt-in, telegram-notify belongs to
# install_telegram_hook.
readonly GRAPH_EXEMPT='["insaits-security","telegram-notify"]'

# This fork's hook-audit defaults (see thaint-setup/HOOK-CATALOG.md, "Turning
# hooks off" — each id there has its own rationale: dead code, duplicate of
# another hook, or an unfinished stub). Applied so a fresh install starts from
# the same audited defaults instead of running every hook the upstream graph
# ships. The list itself lives in disabled-hooks.txt (one id per line, `#`
# comments and blank lines ignored) so adding or dropping a hook is a data
# edit, not a bash edit.
#
# Captured into a plain variable before `readonly`, not `readonly VAR="$(cmd)"`
# directly: bash's readonly/declare/local assignment exit status doesn't
# propagate an inner command substitution's failure to `set -e` (verified:
# `bash -c 'set -e; readonly X="$(false)"; echo reached'` prints "reached" and
# exits 0). The explicit `|| die` below is what actually catches a
# disabled-hooks.txt that filters down to zero active lines.
[[ -f "${SCRIPT_DIR}/disabled-hooks.txt" ]] || die "disabled-hooks.txt missing at ${SCRIPT_DIR}/disabled-hooks.txt"
ecc_disabled_hooks_default="$(grep -v '^[[:space:]]*#' "${SCRIPT_DIR}/disabled-hooks.txt" | grep -v '^[[:space:]]*$' | paste -sd, -)" \
  || die "disabled-hooks.txt at ${SCRIPT_DIR}/disabled-hooks.txt has no active hook entries (all lines are comments/blank) — refusing to silently disable nothing"
readonly ECC_DISABLED_HOOKS_DEFAULT="$ecc_disabled_hooks_default"

# LOCAL (thaint): GateGuard off outright rather than its two hook ids in
# disabled-hooks.txt.
# `off` is one of gateguard-fact-force.js's ECC_DISABLE_VALUES and the check
# runs once at the top of run(), so it covers both the Bash and the Edit/Write
# gate. Audited over a full session: 7 denials, 1 of which surfaced anything
# (a second test file asserting on the file being rewritten). The rest were
# read-only commands, scratch files under the job tmp dir, and overwrites of
# existing files — where its "confirm no existing file serves the same
# purpose" prompt contradicts itself. Cost is not just the round trip: each
# denial forces a facts block into the transcript, spending the context the
# gate exists to protect. Its own suite is 129 pass / 15 fail, so the shipped
# behaviour does not match its spec either.
#
# This also supersedes GATEGUARD_BASH_ROUTINE_DISABLED=1, which this script
# used to set: that only relaxed the routine-Bash path of a gate now off
# entirely.
readonly ECC_GATEGUARD_DEFAULT="off"

# Wires hooks/hooks.json into settings.json, the only place Claude Code reads
# hooks from. The ECC installer copies the hook scripts and writes the same graph
# to ~/.claude/hooks/hooks.json, but deliberately leaves settings.json alone
# (README, "Install hooks") — and Claude Code never reads that file, verified by
# putting a hook there and nowhere else: it never fired. Without this step a
# --target claude install ships 50 hook scripts that no event ever triggers.
#
# Skipped when ECC is loaded as a plugin: Claude Code v2.1+ auto-loads a plugin's
# hooks/hooks.json, so wiring the same graph here would run every hook twice.
install_hook_graph() {
  local settings="${CLAUDE_HOME}/settings.json"
  local graph="${SOURCE}/hooks/hooks.json"
  local tmp names filter line

  [[ -f "$graph" ]] || { warn "hook graph missing at $graph — skipped"; return; }

  # Distinguish "no plugin" from "could not ask". Piping straight into grep
  # would collapse an auth or network failure into the same silent "not
  # installed" answer, and wiring the graph while ECC is in fact a plugin runs
  # every hook twice.
  local plugin_list
  if command -v claude >/dev/null 2>&1; then
    if plugin_list="$(claude plugin list 2>/dev/null)"; then
      if printf '%s' "$plugin_list" | grep -Fq "everything-claude-code"; then
        warn "ECC is installed as a plugin — Claude Code auto-loads its hooks; leaving .hooks alone so they do not run twice"
        return
      fi
    else
      warn "could not read the plugin list — wiring the graph anyway; if ECC is installed as a plugin, remove .hooks or every hook runs twice"
    fi
  fi

  if (( DRY_RUN )); then
    printf '[dry-run] patch %s (.hooks from %s)\n' "$settings" "$graph"
    return
  fi

  [[ -f "$settings" ]] || printf '{}\n' > "$settings"

  # Every ECC hook basename, so an existing entry is classified by what it
  # invokes rather than by how it was written: the old install wired hooks
  # individually and through npx, the graph routes most of them through
  # dispatchers, and matching on names catches both spellings.
  #
  # Globbed rather than found: `find -printf` is GNU-only, and on BSD/macOS the
  # failing pipeline would abort the whole installer here — after the copy
  # steps, before statusline and telegram — leaving nothing behind but find's
  # own one-line complaint about an unknown primary. Worse, anyone who
  # silenced that abort would get an empty name list, which classifies nothing
  # as ECC-owned and so appends the entire graph again on every run.
  local -a hook_names=()
  local hook_file
  for hook_file in "$SOURCE"/scripts/hooks/*.js; do
    [[ -e "$hook_file" ]] || continue
    hook_names+=("$(basename "$hook_file" .js)")
  done
  (( ${#hook_names[@]} )) \
    || die "no hook scripts found in $SOURCE/scripts/hooks — refusing to rewrite .hooks with nothing to match against"
  names="$(printf '%s\n' "${hook_names[@]}" | jq -R . | jq -sc .)"

  # An entry naming an ECC hook is the graph's to define — replaced, and logged
  # so nothing disappears quietly. An entry naming none is yours, and survives.
  filter='
    def cmds: [.. | strings] | join(" ");
    def ecc_owned($names; $exempt):
      cmds as $c
      | any($names[];  . as $n | $c | contains($n))
        and (any($exempt[]; . as $n | $c | contains($n)) | not);
  '

  # Only entries that actually disappear are worth a line: on a re-run every
  # graph entry is "replaced" by its identical self, which is not news.
  while IFS= read -r line; do
    # warn, not log: classification is by hook name, so an entry of your own
    # that reuses an ECC basename lands here too. It goes to stderr where it is
    # harder to scroll past.
    [[ -n "$line" ]] && warn "dropping hook entry the graph supersedes — $line"
  done < <(jq -r --slurpfile g "$graph" --argjson names "$names" --argjson exempt "$GRAPH_EXEMPT" \
    "${filter}"' (.hooks // {}) | to_entries[] | .key as $ev | .value[]
     | select(ecc_owned($names; $exempt))
     | select(. as $e | ($g[0].hooks[$ev] // []) | index($e) | not)
     | ([cmds | scan("scripts/hooks/[A-Za-z0-9._-]+")] | last) as $s
     | $ev + ": " + ($s // ((.hooks[0].command // "") | .[0:60]))' "$settings")

  tmp="$(mktemp)"
  jq --slurpfile g "$graph" --argjson names "$names" --argjson exempt "$GRAPH_EXEMPT" \
    "${filter}"'
    ($g[0].hooks) as $new
    | (.hooks // {}) as $old
    | .hooks = (
        reduce ((($new | keys_unsorted) + ($old | keys_unsorted)) | unique)[] as $ev
          ({};
            .[$ev] = (
              ($new[$ev] // [])
              + (($old[$ev] // []) | map(select(ecc_owned($names; $exempt) | not)))
            )
          )
      )
  ' "$settings" > "$tmp" \
    || die "jq failed to wire the hook graph into $settings"
  mv "$tmp" "$settings"
  log "wired hook graph ($(jq '[.hooks[][].hooks[]] | length' "$settings") entries in settings.json)"
}

# Splits a comma-separated hook-id list into a sorted, deduped, comma-joined
# form so two lists differing only in order/duplicates compare as equal.
normalize_hook_list() {
  printf '%s' "$1" | tr ',' '\n' | sort -u | paste -sd, -
}

# Applies this fork's hook-audit defaults (ECC_DISABLED_HOOKS, ECC_GATEGUARD)
# to settings.json's env block. Only sets a key that is absent — an existing
# value is assumed to be a deliberate choice (yours, or a previous run's) and
# is left alone, same as the statusLine hand-edit check below.
#
# That only-if-absent rule is why ECC_GATEGUARD reaches installs that already
# exist while a disabled-hooks.txt edit would not: ECC_DISABLED_HOOKS is
# already written on every prior install, so a new entry there is kept out by
# the `//` fallback and only warned about. ECC_GATEGUARD has never been set by
# this script, so it is absent everywhere and gets applied on the next run.
ensure_ecc_hook_config() {
  local settings="${CLAUDE_HOME}/settings.json"

  if (( DRY_RUN )); then
    printf '[dry-run] patch %s (env.ECC_DISABLED_HOOKS, env.ECC_GATEGUARD — only if unset)\n' "$settings"
    return
  fi

  [[ -f "$settings" ]] || printf '{}\n' > "$settings"

  local existing_disabled existing_gateguard
  existing_disabled="$(jq -r '.env.ECC_DISABLED_HOOKS // ""' "$settings")"
  existing_gateguard="$(jq -r '.env.ECC_GATEGUARD // ""' "$settings")"

  # Compared as normalized sets, not raw strings: the actual runtime behavior
  # (hook-flags.js's getDisabledHookIds() splits on `,` into a Set) never
  # depends on order, so a pure reorder of disabled-hooks.txt must not warn
  # every existing install about a "different value" that changes nothing.
  if [[ -n "$existing_disabled" \
        && "$(normalize_hook_list "$existing_disabled")" != "$(normalize_hook_list "$ECC_DISABLED_HOOKS_DEFAULT")" ]]; then
    warn "env.ECC_DISABLED_HOOKS already set to a different value — keeping it (see thaint-setup/HOOK-CATALOG.md for this fork's defaults)"
  fi
  # Compared case-insensitively: gateguard-fact-force.js lowercases the value
  # before testing it against ECC_DISABLE_VALUES, so `OFF` and `off` behave
  # identically at runtime and warning about the difference would be noise.
  if [[ -n "$existing_gateguard" \
        && "$(printf '%s' "$existing_gateguard" | tr '[:upper:]' '[:lower:]')" != "$ECC_GATEGUARD_DEFAULT" ]]; then
    warn "env.ECC_GATEGUARD already set to a different value — keeping it (see thaint-setup/HOOK-CATALOG.md, \"Turning hooks off\")"
  fi

  local tmp
  tmp="$(mktemp)"
  jq \
    --arg disabled "$ECC_DISABLED_HOOKS_DEFAULT" \
    --arg gateguard "$ECC_GATEGUARD_DEFAULT" \
    '.env //= {}
     | .env.ECC_DISABLED_HOOKS = (.env.ECC_DISABLED_HOOKS // $disabled)
     | .env.ECC_GATEGUARD = (.env.ECC_GATEGUARD // $gateguard)' \
    "$settings" > "$tmp" \
    || die "jq failed to patch hook-audit env defaults in $settings"
  mv "$tmp" "$settings"
  log "applied hook-audit env defaults (ECC_DISABLED_HOOKS, ECC_GATEGUARD) where unset"
}

# Installs ECC's statusline, which shows more than the inline bash bar it
# replaced: model, the in-progress task, session cost/tool/file counts (once
# ecc-metrics-bridge runs), the working directory, and the context bar.
# Overwrites only a value this script wrote — see the ownership check below.
patch_settings_statusline() {
  local settings="${CLAUDE_HOME}/settings.json"
  local tmp existing
  local statusline_cmd="node \"${CLAUDE_HOME}/scripts/hooks/ecc-statusline.js\""

  if (( DRY_RUN )); then
    printf '[dry-run] patch %s (.statusLine)\n' "$settings"
    return
  fi

  [[ -f "$settings" ]] || printf '{}\n' > "$settings"

  # `ecc-statusline.js` is what this script writes now; `bar_total=30` is the
  # inline bash bar earlier versions wrote. Anything else was chosen by hand, so
  # keep it rather than silently reverting that choice on every run.
  existing="$(jq -r '.statusLine.command // ""' "$settings")"
  if [[ -n "$existing" \
        && "$existing" != *ecc-statusline.js* \
        && "$existing" != *bar_total=30* ]]; then
    warn "statusLine is hand-edited — keeping it (remove .statusLine to hand it back to this script)"
    return
  fi

  tmp="$(mktemp)"
  jq --arg cmd "$statusline_cmd" \
    '.statusLine = { "type": "command", "command": $cmd, "refreshInterval": 20 }' \
    "$settings" > "$tmp" \
    || die "jq failed to patch statusLine in $settings"
  mv "$tmp" "$settings"
  log "patched settings.json (.statusLine -> ecc-statusline.js, refreshInterval 20s)"
}

# This fork only wants a subset of ECC's MCP catalog installed: docs lookup,
# browser automation, web search/scraping, design tooling, and issue/doc
# trackers. Everything else in mcp-servers.json (cloud infra, extra memory
# servers, code-quality tools, etc.) is skipped rather than installed disabled.
readonly MCP_ALLOWLIST='["context7","playwright","browser-use","browserbase","exa-web-search","parallel-search","firecrawl","magic","laraplugins","jira","confluence"]'

# ── MCP catalog patch ───────────────────────────────────────────────────────
# Reads ECC's mcp-servers.json catalog, filters it down to MCP_ALLOWLIST, and
# installs the result into ~/.claude.json (user scope) with ${VAR}
# placeholders. Servers without required env vars will fail to parse
# (effectively disabled); set the env var to auto-enable. Always overwrites
# .mcpServers so config matches exactly.
patch_mcp_catalog() {
  local config="${HOME}/.claude.json"
  local mcp_src="${SOURCE}/mcp-configs/mcp-servers.json"
  local tmp

  if (( DRY_RUN )); then
    printf '[dry-run] patch %s (.mcpServers)\n' "$config"
    return
  fi

  [[ -f "$mcp_src" ]] || { warn "ECC mcp-servers.json not found at $mcp_src — skipped"; return; }

  # 1. Replace all YOUR_*_HERE placeholders with ${VAR_NAME} syntax, looked up
  #    from mcp-placeholder-map.json — adding a new MCP server's placeholder is
  #    a data edit to that file, not a bash edit here.
  #    Claude Code expands ${VAR} in command/args/env/url/headers fields.
  #    If the env var is unset, parsing fails and the server stays disabled.
  # 2. Replace filesystem path placeholder with a safe default.
  # 3. Strip description fields and _comments (not valid in .claude.json).
  local placeholder_map="${SCRIPT_DIR}/mcp-placeholder-map.json"
  [[ -f "$placeholder_map" ]] || die "mcp-placeholder-map.json missing at $placeholder_map"

  # An empty/null value would still match and substitute via gsub below,
  # producing a literal "${}" that the unmapped-placeholder check further
  # down cannot catch (it only looks for YOUR_..._HERE text, which would
  # already be gone) — so guard against it here instead.
  local empty_placeholder_keys
  empty_placeholder_keys="$(jq -r '[to_entries[] | select(.value == "" or .value == null) | .key] | join(", ")' "$placeholder_map")"
  [[ -z "$empty_placeholder_keys" ]] \
    || die "mcp-placeholder-map.json has empty/null values for: $empty_placeholder_keys — every placeholder must map to a non-empty env-var name"

  local mcp_processed
  mcp_processed="$(mktemp)"
  sed \
    -e 's|/path/to/your/projects|${MCP_FILESYSTEM_PATH:-$HOME}|g' \
    "$mcp_src" \
    | jq --slurpfile map "$placeholder_map" '
      def fix_placeholders($m):
        if type == "object" then
          to_entries
          | map(
            if .value == null then .
            elif (.key == "description") then empty
            else .value = (.value | fix_placeholders($m)) | .
            end
          )
          | from_entries
        elif type == "array" then
          map(fix_placeholders($m))
        elif type == "string" then
          reduce ($m | to_entries[]) as $e (.; gsub($e.key; "${" + $e.value + "}"))
        else .
        end;

      ($map[0]) as $m
      | del(._comments)
      | .mcpServers |= (map_values(fix_placeholders($m)) | with_entries(select(.key as $k | $allowlist | index($k))))
    ' --argjson allowlist "$MCP_ALLOWLIST" > "$mcp_processed" \
    || die "jq failed to process MCP catalog from $mcp_src"

  # Any placeholder still present would be written to ~/.claude.json literally,
  # making the server look configured instead of staying disabled. Fail loudly
  # so a newly added upstream server can't slip through unmapped.
  local unmapped
  # grep exits 1 when it finds nothing — the healthy case — and `set -e` treats
  # that as a failure, aborting the install right before anything is copied.
  unmapped="$(grep -oE 'YOUR_[A-Z0-9_]*_HERE' "$mcp_processed" | sort -u | tr '\n' ' ')" || unmapped=''
  [[ -z "$unmapped" ]] || die "unmapped MCP placeholders (add to fix_placeholders): $unmapped"

  [[ -f "$config" ]] || printf '{}\n' > "$config"

  tmp="$(mktemp)"
  jq --slurpfile mcp "$mcp_processed" \
    '.mcpServers = $mcp[0].mcpServers' \
    "$config" > "$tmp" \
    || die "jq failed to merge MCP servers into $config"
  local count
  count="$(jq '.mcpServers | length' "$tmp")"
  mv "$tmp" "$config"
  rm -f "$mcp_processed"
  log "patched .claude.json ($count MCP servers cataloged)"
}

# ── Shell helpers ────────────────────────────────────────────────────────────
# Installs <plan>_clauded() wrappers as a sourced file under ~/.claude/setup/.
# A "<plan>_clauded" runs claude with the gateway block from
# ~/coding_plan/<plan>.env — so plain `claude` never routes through a gateway
# (it stays on the user's Anthropic subscription), and switching plans is just
# choosing a function.  One generic dispatcher below holds the shared logic,
# and each plan is a thin 1-line wrapper delegating to it; adding a plan means
# dropping <plan>.env into ~/coding_plan/ plus one wrapper line, nothing else.
# The clauded alias is managed by patch_shell_rc below.
readonly SHELL_HELPERS_DIR="${CLAUDE_HOME}/setup"
readonly PLAN_DIR="${HOME}/coding_plan"
ensure_shell_helpers() {
  local helper="${SHELL_HELPERS_DIR}/clauded-plan.sh"

  if (( DRY_RUN )); then
    printf '[dry-run] write %s\n' "$helper"
    printf '[dry-run] (patch_shell_rc: alias clauded + source clauded-plan.sh)\n'
    return
  fi

  run mkdir -p "$SHELL_HELPERS_DIR"
  cat > "$helper" <<EOF
# Managed by setup_claude.sh — re-run the installer to refresh.
# Plain \`claude\` in a new shell does NOT route through any gateway block;
# only the <plan>_clauded() wrappers below do.  Plan gateway blocks live in
# ${PLAN_DIR}/<plan>.env — edit those files, not this one.

# clauded_plan <plan> [claude args...]  — sources ~/coding_plan/<plan>.env
PLAN_DIR="${PLAN_DIR}"
clauded_plan() {
  local plan src
  plan="\${1:?usage: clauded_plan <plan> [claude args]}"; shift
  src="\${PLAN_DIR}/\${plan}.env"
  if [[ ! -f "\$src" ]]; then
    echo "[clauded_plan] no plan '\$plan' — available: \$(cd "\$PLAN_DIR" 2>/dev/null && printf '%s ' *.env)" >&2
    echo "[clauded_plan] falling back to plain claude" >&2
    exec claude "\$@"
  fi
  ( set -a; source "\$src"; set +a; exec claude --dangerously-skip-permissions --effort max "\$@" )
}

# One thin wrapper per plan.  The function name is semantic, not derived from
# the filename — keeping them as plain named functions keeps them greppable
# and zsh-completable, and adding a plan is just dropping in one line.
ocgo_clauded() { clauded_plan opencode_go "\$@"; }
# ali_clauded() { clauded_plan alibaba "\$@"; }
EOF
  run chmod 700 "$helper"
  log "wrote $helper (clauded_plan + <plan>_clauded wrappers)"
}

# ── Shell RC patch ───────────────────────────────────────────────────────────
# Patches the user's login shell rc with convenience alias + env.
# Priority: $SHELL (login shell) → existing file → skip.
patch_shell_rc() {
  local alias_line="alias clauded='claude --dangerously-skip-permissions'"
  local env_line="export CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1"
  local helper="${SHELL_HELPERS_DIR}/clauded-plan.sh"
  local helper_source="[[ -f \"${helper}\" ]] && source \"${helper}\""

  local shell_rc=""
  # $SHELL is the login shell, not the current process — works even when script
  # runs under bash (#!/usr/bin/env bash) but user's login shell is zsh.
  case "${SHELL:-}" in
    */zsh) shell_rc="${HOME}/.zshrc" ;;
    */bash) shell_rc="${HOME}/.bashrc" ;;
  esac

  # Fallback: if $SHELL didn't help, pick whichever file actually exists.
  if [[ -z "$shell_rc" ]]; then
    if [[ -f "${HOME}/.zshrc" ]]; then
      shell_rc="${HOME}/.zshrc"
    elif [[ -f "${HOME}/.bashrc" ]]; then
      shell_rc="${HOME}/.bashrc"
    else
      warn "no .zshrc or .bashrc found — skipping shell rc patch"
      return
    fi
  fi

  if (( DRY_RUN )); then
    printf '[dry-run] patch %s (alias clauded + source clauded-plan.sh + env)\n' "$shell_rc"
    return
  fi

  # Skip touch when nothing needs to be appended — avoids unnecessary mtime change.
  local needs_append=0
  if ! grep -qF "$alias_line" "$shell_rc"; then needs_append=1; fi
  if ! grep -qF "$env_line" "$shell_rc"; then needs_append=1; fi
  if ! grep -qF "clauded-plan.sh" "$shell_rc"; then needs_append=1; fi
  if (( needs_append )); then
    touch "$shell_rc"
  fi

  if ! grep -qF "$alias_line" "$shell_rc"; then
    printf '\n%s\n' "$alias_line" >> "$shell_rc"
    log "added alias to $shell_rc"
  else
    log "alias already present in $shell_rc"
  fi

  if ! grep -qF "$env_line" "$shell_rc"; then
    printf '%s\n' "$env_line" >> "$shell_rc"
    log "added env to $shell_rc"
  else
    log "env already present in $shell_rc"
  fi

  if ! grep -qF "clauded-plan.sh" "$shell_rc"; then
    printf '%s\n' "$helper_source" >> "$shell_rc"
    log "added clauded_plan source line to $shell_rc"
  else
    log "clauded_plan source line already present in $shell_rc"
  fi
}

# ── Settings: backup then patch ─────────────────────────────────────────────
# Snapshot the files we overwrite, before any mutation. Patches run after.
# ~/.claude.json matters as much as settings.json: patch_mcp_catalog replaces
# .mcpServers wholesale, which drops any server the user configured by hand.
backup_one() {
  local src="$1" name="$2"
  [[ -f "$src" ]] || return 0
  local dir="${CLAUDE_HOME}/backups"
  local out
  out="${dir}/${name}.bak-$(date +%Y%m%d-%H%M%S)-$$"
  run mkdir -p "$dir"
  run cp "$src" "$out"
  log "backup: ${out#${CLAUDE_HOME}/}"
}

backup_settings() {
  backup_one "${CLAUDE_HOME}/settings.json" 'settings.json'
  backup_one "${HOME}/.claude.json" 'claude.json'
}

# ── Global CLAUDE.md ────────────────────────────────────────────────────────
# Copies CLAUDE.base.md to ~/.claude/CLAUDE.md (global rules).
# This applies across all projects as behavioral guidelines.
install_global_claude_md() {
  local dest="${CLAUDE_HOME}/CLAUDE.md"
  local src="${SCRIPT_DIR}/CLAUDE.base.md"

  if (( DRY_RUN )); then
    printf '[dry-run] copy %s -> %s (global CLAUDE.md)\n' "$src" "$dest"
    return
  fi

  [[ -f "$src" ]] || { warn "CLAUDE.base.md not found at $src — skipped"; return; }

  run cp "$src" "$dest"
  log "installed global CLAUDE.md at $dest"
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  parse_args "$@"
  require_cmd jq
  run mkdir -p "$CLAUDE_HOME"

  ensure_claude_code
  ensure_onboarding
  ensure_marketplace
  ensure_plugin

  log "destination: $CLAUDE_HOME"
  log "source: $SOURCE ($(describe_source))"
  if (( DRY_RUN )); then
    log "DRY RUN — no changes will be made"
  fi

  backup_settings
  patch_mcp_catalog
  load_env
  install_global_claude_md
  install_all_dirs
  install_hooks_runtime
  # Both need install_hooks_runtime to have copied the scripts they point at.
  install_hook_graph
  ensure_ecc_hook_config
  patch_settings_statusline
  install_telegram_hook
  ensure_apply_env "${CLAUDE_HOME}/settings.json"
  ensure_shell_helpers
  patch_shell_rc

  log "done"
}

main "$@"
