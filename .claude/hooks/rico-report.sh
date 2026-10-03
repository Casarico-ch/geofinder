#!/usr/bin/env bash
# rico-report — the machine carries the news (23.09.2026).
#
# Why this exists: many cockpit workers read their start message as a prompt
# injection, refuse to fetch their card key, do the work anyway and report it
# in a chat nobody reads. The cards then sit silent, get knocked, refuse again
# and end in front of Daniel. A hook committed in the repository runs inside
# the Conductor workspace whatever the model decides (proven live 23.09 on
# card bmudosmmm3xx), so the reporting no longer depends on the model agreeing.
#
# What it does, PostToolUse on Bash only:
#   1. Nothing at all unless this is a cockpit workspace (RICO_GATEWAY_KEY set).
#      A developer's local Claude Code is untouched.
#   2. The fast path is one `git rev-parse HEAD` compared with the last HEAD it
#      reported. No new commit, no work: this runs after every command.
#   3. On a new commit it fetches the card key ONCE with the workspace's own
#      gateway key (GET /api/card-key), keeps it in a mode-600 file inside .git,
#      and never prints it. Then it pushes HEAD to claude/card-<id> and posts a
#      short note to the card: "pushed <sha>: <subject>", as the worker's role,
#      marked via:"hook" so the cockpit reads it as the machine's evidence.
#   4. At most one note a minute. A later commit inside the minute is pushed at
#      once and reported by the first command after the minute is up.
#   5. It never blocks the model: the network half runs detached, every call has
#      a short timeout, it always exits 0, and every failure goes to a local log
#      (.git/rico-report/log), never to the chat.
#
# What it deliberately does NOT do: move a column, answer a question, open a
# pull request. Those carry judgement and stay with the cockpit or the worker.

[ -n "${RICO_GATEWAY_KEY:-}" ] || exit 0
# the tool call on stdin is not needed; drain it so the caller never blocks on a pipe
cat >/dev/null 2>&1 || true

cd "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null || exit 0
GITDIR="$(git rev-parse --absolute-git-dir 2>/dev/null)" || exit 0
HEAD="$(git rev-parse -q --verify HEAD 2>/dev/null)" || exit 0
STATE="$GITDIR/rico-report"
[ "$(cat "$STATE/seen" 2>/dev/null)" = "$HEAD" ] && exit 0
umask 077
mkdir -p "$STATE" 2>/dev/null || exit 0

# ONLY WORK MADE HERE IS NEWS (24.09). A fresh workspace has no "seen" yet, so
# the first command after it opened used to report whatever HEAD was — the
# base branch it started from ("Merge pull request #1160…", "Card record
# flush") — as the worker's push: on 29 of 29 Build cards that day, making
# silent cards look alive and pushing main's tip to claude/card-<id>, where
# the cockpit then tried to open a pull request with no commits in it. Two
# things are not this worker's news, and both are remembered as seen with
# nothing pushed, fetched or posted:
#   - whatever HEAD is the very first time the hook runs in this workspace:
#     that is where the machine started, not work done on it;
#   - a commit the repository's default branch already contains (a checkout
#     or reset back to main).
# Deliberately NOT "any remote branch contains it": the push below and a
# worker's own `git push` both put real work on a remote branch, and that
# work must still be reported.
if [ ! -e "$STATE/seen" ]; then
  printf '%s' "$HEAD" >"$STATE/seen" 2>/dev/null
  exit 0
fi
TRUNK="$(git symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null)"
[ -n "$TRUNK" ] || for T in refs/remotes/origin/main refs/remotes/origin/master; do git show-ref -q --verify "$T" 2>/dev/null && { TRUNK="$T"; break; }; done
if [ -n "$TRUNK" ] && git merge-base --is-ancestor "$HEAD" "$TRUNK" 2>/dev/null; then
  printf '%s' "$HEAD" >"$STATE/seen" 2>/dev/null
  exit 0
fi

run() {
  LOG="$STATE/log"
  log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG" 2>/dev/null; }
  # one reporter at a time; a lock older than two minutes belonged to a dead one
  if ! mkdir "$STATE/lock" 2>/dev/null; then
    [ -n "$(find "$STATE/lock" -maxdepth 0 -mmin +2 2>/dev/null)" ] || return 0
    rmdir "$STATE/lock" 2>/dev/null; mkdir "$STATE/lock" 2>/dev/null || return 0
  fi
  trap 'rmdir "$STATE/lock" 2>/dev/null' EXIT

  URL="${RICO_GATEWAY_URL:-https://rico-cockpit-production.up.railway.app/claude}"
  BASE="${URL%/}"; BASE="${BASE%/claude}"
  HEAD="$(git rev-parse -q --verify HEAD 2>/dev/null)" || return 0
  NOW="$(date +%s)"

  # the card key: fetched once, kept 600, never printed; a refused note drops it
  if [ ! -s "$STATE/card" ] || [ ! -s "$STATE/key" ]; then
    # headers from a 600 file, so no key ever sits in a process list
    printf 'Authorization: Bearer %s\n' "$RICO_GATEWAY_KEY" >"$STATE/gw-auth"
    curl -sS --connect-timeout 3 --max-time 8 -H @"$STATE/gw-auth" "$BASE/api/card-key" 2>>"$LOG" \
    | node -e '
      let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
        let j = {}; try { j = JSON.parse(s); } catch (_) {}
        if (!j.ok || !j.card || !j.key) { process.stderr.write("card-key refused: " + String(j.error || "no card").slice(0, 200) + "\n"); process.exit(1); }
        const fs = require("fs"), d = process.argv[1];
        fs.writeFileSync(d + "/key", "Authorization: Bearer " + String(j.key) + "\n", { mode: 0o600 });
        fs.writeFileSync(d + "/card", [j.card, j.role || "Lead", j.post || ""].join("\n"), { mode: 0o600 });
      });' "$STATE" 2>>"$LOG" || { log "no card key"; return 0; }
  fi
  CARD="$(sed -n 1p "$STATE/card")"; ROLE="$(sed -n 2p "$STATE/card")"; POST="$(sed -n 3p "$STATE/card")"
  [ -n "$POST" ] || POST="$BASE/api/build"
  case "$CARD" in ''|*[!A-Za-z0-9_-]*) log "card id unusable"; rm -f "$STATE/card" "$STATE/key"; return 0 ;; esac
  BRANCH="claude/card-$CARD"

  # push the card branch; never forced — a rewritten history is the worker's to push
  if [ "$(cat "$STATE/pushed" 2>/dev/null)" != "$HEAD" ]; then
    if GIT_TERMINAL_PROMPT=0 timeout 30 git push -q origin "HEAD:refs/heads/$BRANCH" >>"$LOG" 2>&1; then
      printf '%s' "$HEAD" >"$STATE/pushed"
    else
      log "push of $HEAD to $BRANCH failed"; return 0
    fi
  fi

  # throttle: one note a minute
  LAST="$(cat "$STATE/noted-at" 2>/dev/null || echo 0)"
  [ $((NOW - LAST)) -ge 60 ] || return 0

  SHA="$(git rev-parse --short HEAD)"; SUBJ="$(git log -1 --format=%s HEAD 2>/dev/null)"
  BODY="$(RICO_CARD="$CARD" RICO_ROLE="$ROLE" RICO_SHA="$SHA" RICO_FULL="$HEAD" RICO_SUBJ="$SUBJ" RICO_BRANCH="$BRANCH" node -e '
    const e = process.env;
    process.stdout.write(JSON.stringify({ id: e.RICO_CARD, note: {
      agent: e.RICO_ROLE, via: "hook", tone: "info", verdict: "pushed " + e.RICO_SHA,
      text: "pushed " + e.RICO_SHA + ": " + String(e.RICO_SUBJ || "").slice(0, 200),
      commit: e.RICO_FULL, branch: e.RICO_BRANCH } }));')" || return 0
  CODE="$(printf '%s' "$BODY" | curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 8 \
    -H @"$STATE/key" -H 'Content-Type: application/json' --data-binary @- "$POST" 2>>"$LOG")"
  case "$CODE" in
    2*) printf '%s' "$NOW" >"$STATE/noted-at"; printf '%s' "$HEAD" >"$STATE/seen" ;;
    401|403|409) log "note refused ($CODE); the card key is dropped for a fresh fetch"; rm -f "$STATE/card" "$STATE/key" ;;
    *) log "note failed (${CODE:-no answer})" ;;
  esac
  return 0
}

# detached: the model's next command never waits on the network
( run ) </dev/null >/dev/null 2>&1 &
exit 0
