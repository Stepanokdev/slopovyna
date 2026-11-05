#!/usr/bin/env bash
# Production: a room link opened without signing in carries the general preview and nothing of the
# room; a GitHub sign-in produced a live session for a real GitHub account.
#   ops/check-public.sh <room id> "<room title that must stay private>"
set -euo pipefail
cd "$(dirname "$0")"; . ./_ssh.sh
ROOM=${1:?}; TITLE=${2:?}
html=$(curl -fsS https://slop.bulava.app/r/$ROOM)
echo "$html" | grep -q 'og:title" content="Slopovyna' && echo "og:title is Slopovyna"
echo "$html" | grep -q 'og:image" content="https://slop.bulava.app/img/og.png"' && echo "og:image is the Slopovyna card"
[ "$(curl -fsS -o /dev/null -w '%{content_type} %{size_download}' https://slop.bulava.app/img/og.png | cut -d' ' -f1)" = image/png ]
echo "$html" | grep -qF "$TITLE" && { echo "room title leaked"; exit 1; } || echo "room title not in the public page"
[ "$(curl -s -o /dev/null -w %{http_code} https://slop.bulava.app/api/rooms/$ROOM)" = 401 ] && echo "room API without a session: 401"
# Sessions can only come from the GitHub callback in production (no local login): a real GitHub id
# (local ids start at 1e9) with an unexpired session.
prod "docker exec slopovyna node -e '
  const d = new (require(\"node:sqlite\").DatabaseSync)(\"/data/slop.db\");
  const r = d.prepare(\"SELECT u.login, u.github_id, count(*) n FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.expires_at > ? AND u.github_id < 1000000000 GROUP BY u.id\").all(Date.now());
  if (!r.length) { console.log(\"no GitHub session\"); process.exit(1); }
  for (const x of r) console.log(\"GitHub session for @\" + x.login + \" (github id \" + x.github_id + \"): \" + x.n);'"
