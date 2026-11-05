#!/usr/bin/env bash
# The public repository and what runs from it:
#  - public, AGPL-3.0 detected, homepage and topics set, docs in both languages;
#  - GitHub main is the local HEAD, and the running container holds exactly the server files of that
#    published commit (package.json, src, public, cli: same paths, same sha256);
#  - no secrets in the tree or the history, ops scripts carry no server address;
#  - a fresh clone from GitHub passes the tests, and `npm run dev` starts with the local sign-in.
#   ops/check-github.sh            needs PROD_URL, PROD_HOST, PROD_SSH (see _env.sh)
#   ops/check-github.sh --local    skips the comparison with the running container (no SSH)
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
if [ "${1:-}" = --local ]; then . "$here/_env.sh"; else . "$here/_ssh.sh"; fi
cd "$(git rev-parse --show-toplevel)"
R=${GITHUB_REPO:-Stepanokdev/slopovyna}
d=$(mktemp -d); dev=""
cleanup() { [ -n "$dev" ] && pkill -f "$d/c/server" 2>/dev/null; rm -rf "$d"; }
trap cleanup EXIT

j=$(curl -fsS "https://api.github.com/repos/$R") || { echo "FAIL: repository not reachable"; exit 1; }
need "public"                 grep -q '"private": false' <<<"$j"
need "license AGPL-3.0"       grep -q '"spdx_id": "AGPL-3.0"' <<<"$j"
need "homepage is $PROD_URL"  grep -qF "\"homepage\": \"$PROD_URL\"" <<<"$j"
for t in claude-code codex ai-agents multi-agent; do need "topic $t" grep -q "\"$t\"" <<<"$j"; done
for f in LICENSE README.md README.uk.md SECURITY.md CONTRIBUTING.md docs/room-en.png docs/room-uk.png; do need "$f" git cat-file -e "HEAD:$f"; done
need "README links to README.uk.md"  grep -q 'README.uk.md' README.md
need "README.uk links back"          grep -q 'href="README.md"' README.uk.md

need "clone from GitHub" git clone -q "https://github.com/$R.git" "$d/c"
pub=$(git -C "$d/c" rev-parse HEAD)
need "GitHub main = local HEAD ($pub)" test "$pub" = "$(git rev-parse HEAD)"
if [ "${1:-}" != --local ]; then
  (cd "$d/c/server" && git ls-files package.json src public cli | sort | xargs shasum -a 256) > "$d/published.txt"
  prod "docker exec slopovyna sh -c 'cd /app && find package.json src public cli -type f | sort | xargs sha256sum'" > "$d/running.txt"
  need "running container = published commit ($(wc -l <"$d/published.txt" | tr -d ' ') files)" diff "$d/published.txt" "$d/running.txt"
fi

need "tree: no keys" bash -c "! git grep -qIE 'BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}' -- . ':!server/test'"
need "ops: no server address or key path" bash -c "! git grep -hIE 'https?://[a-z0-9.-]+\\.[a-z]{2,}|[0-9]{1,3}(\\.[0-9]{1,3}){3}|ssh_key' -- server/ops ':!server/ops/check-github.sh' | grep -vE 'https://(slop\\.example\\.com|your\\.host)'"
need "history: no env, db or key files" bash -c "! git log --all --name-only --format= | grep -qiE '(^|/)\\.env\$|\\.db\$|secret\\.key\$|\\.pem\$|prod\\.env\$'"
need "history: no secrets" bash -c "! git log --all -p | grep -E '^\\+' | grep -qE 'BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/]|AKIA[0-9A-Z]{16}\\b|sk-ant-[A-Za-z0-9_-]{30,}|GITHUB_CLIENT_SECRET=[0-9a-f]{20}'"
for f in server/ops/.prod.env .env server/.env x.pem data/slop.db secret.key; do need "gitignore: $f" git check-ignore "$f"; done

need "fresh clone: npm test" bash -c "cd '$d/c/server' && npm test"
# README: `npm run dev` gives http://localhost:3000 with a local sign-in form. A free port is used here.
port=$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')
(cd "$d/c/server" && PORT=$port npm run dev >"$d/dev.log" 2>&1 &); dev=1
for i in $(seq 1 40); do curl -fsS "http://localhost:$port/healthz" >/dev/null 2>&1 && break; sleep 0.25; done
B=http://localhost:$port
need "npm run dev answers"               test "$(curl -fsS $B/healthz)" = ok
need "the page offers the local sign-in" bash -c "curl -fsS $B/config.json | grep -q '\"devLogin\":true'"
cookie=$(curl -fsS -o /dev/null -D - "$B/auth/dev?login=readme-check&name=Readme" | sed -nE 's/^[Ss]et-[Cc]ookie: (slop_s=[^;]+).*/\1/p')
need "local sign-in sets a session"      test -n "$cookie"
need "signed in as readme-check"         bash -c "curl -fsS -H 'Cookie: $cookie' $B/api/me | grep -q '\"login\":\"readme-check\"'"
pkill -f "$d/c/server" 2>/dev/null; dev=""; sleep 0.5
need "dev server stopped"                bash -c "! curl -fsS $B/healthz"
