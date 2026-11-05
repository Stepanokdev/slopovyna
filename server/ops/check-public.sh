#!/usr/bin/env bash
# Production: a room link opened without signing in carries the general preview and nothing of the
# room; a GitHub sign-in produced a live session for a real GitHub account.
#   ops/check-public.sh <room id> "<room title that must stay private>"
set -euo pipefail
cd "$(dirname "$0")"; . ./_ssh.sh
ROOM=${1:?}; TITLE=${2:?}
U=$PROD_URL
html=$(curl -fsS $U/r/$ROOM)
need "og:title is Slopovyna"            grep -q 'og:title" content="Slopovyna' <<<"$html"
need "a new visitor gets English"       grep -q '<html lang="en">' <<<"$html"
need "og:image is the English card"     grep -qF "og:image\" content=\"$U/img/og-en.png\"" <<<"$html"
need "slop_lang=uk: the Ukrainian card" bash -c "curl -fsS -H 'Cookie: slop_lang=uk' $U/r/$ROOM | grep -qF 'og:image\" content=\"$U/img/og-uk.png\"'"
for l in en uk; do need "og-$l.png is an image" test "$(curl -fsS -o /dev/null -w '%{content_type}' $U/img/og-$l.png)" = image/png; done
need "room title not in the public page" bash -c '! grep -qF "$0" <<<"$1"' "$TITLE" "$html"
need "room API without a session: 401"  test "$(curl -s -o /dev/null -w %{http_code} $U/api/rooms/$ROOM)" = 401
# Sessions can only come from the GitHub callback in production (no local login): a real GitHub id
# (local ids start at 1e9) with an unexpired session.
prod "docker exec slopovyna node -e '
  const d = new (require(\"node:sqlite\").DatabaseSync)(\"/data/slop.db\");
  const r = d.prepare(\"SELECT u.login, u.github_id, count(*) n FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.expires_at > ? AND u.github_id < 1000000000 GROUP BY u.id\").all(Date.now());
  if (!r.length) { console.log(\"no GitHub session\"); process.exit(1); }
  for (const x of r) console.log(\"GitHub session for @\" + x.login + \" (github id \" + x.github_id + \"): \" + x.n);'"
