#!/usr/bin/env bash
# The public repository: the same commit as local main, AGPL-3.0 detected, metadata set, docs in both
# languages, no secrets in the tree or the history, and a fresh clone from GitHub passes the tests.
#   ops/check-github.sh            (run from anywhere inside the repository)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
R=${GITHUB_REPO:-Stepanokdev/slopovyna}
ok() { echo "ok: $1"; }
need() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else echo "FAIL: $what"; exit 1; fi; }
j=$(curl -fsS "https://api.github.com/repos/$R") || { echo "FAIL: repository not reachable"; exit 1; }
need "public"                 grep -q '"private": false' <<<"$j"
need "license AGPL-3.0"       grep -q '"spdx_id": "AGPL-3.0"' <<<"$j"
need "homepage"               grep -q '"homepage": "https://slop.bulava.app"' <<<"$j"
for t in claude-code codex ai-agents multi-agent; do need "topic $t" grep -q "\"$t\"" <<<"$j"; done
remote=$(git ls-remote "https://github.com/$R.git" refs/heads/main | cut -c1-40)
need "GitHub main = local HEAD" test "$remote" = "$(git rev-parse HEAD)"
for f in LICENSE README.md README.uk.md SECURITY.md CONTRIBUTING.md docs/room-en.png docs/room-uk.png; do need "$f" git cat-file -e "HEAD:$f"; done
need "README links to README.uk.md"  grep -q 'README.uk.md' README.md
need "README.uk links back"          grep -q '(README.md)' README.uk.md
need "tree: no keys or server address" bash -c "! git grep -qIE 'BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}.*PROD|ssh_key\"' -- . ':!server/test'"
need "history: no env, db or key files" bash -c "! git log --all --name-only --format= | grep -qiE '(^|/)\\.env\$|\\.db\$|secret\\.key\$|\\.pem\$|prod\\.env\$'"
need "history: no secrets" bash -c "! git log --all -p | grep -E '^\\+' | grep -qE 'BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/]|AKIA[0-9A-Z]{16}\\b|sk-ant-[A-Za-z0-9_-]{30,}|GITHUB_CLIENT_SECRET=[0-9a-f]{20}'"
for f in server/ops/.prod.env .env server/.env x.pem data/slop.db secret.key; do need "gitignore: $f" git check-ignore "$f"; done
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
need "clone from GitHub" git clone -q "https://github.com/$R.git" "$d/c"
need "fresh clone: npm test" bash -c "cd '$d/c/server' && npm test"
