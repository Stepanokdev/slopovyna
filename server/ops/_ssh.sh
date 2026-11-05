# The checks that log in to the server: PROD_HOST and PROD_SSH, from the environment or ops/.prod.env.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_env.sh"
: "${PROD_HOST:?set PROD_HOST=user@host (or put it in ops/.prod.env)}"
: "${PROD_SSH:?set PROD_SSH=/path/to/private/key (or put it in ops/.prod.env)}"
prod() { ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i "$PROD_SSH" "$PROD_HOST" "$@"; }
# What the database holds, as one line of JSON, read inside the running container.
snapshot() {
  prod "docker exec slopovyna node -e '
    const d = new (require(\"node:sqlite\").DatabaseSync)(\"/data/slop.db\");
    const now = Date.now();
    console.log(JSON.stringify({
      rooms: d.prepare(\"SELECT id FROM rooms ORDER BY id\").all().map(r => r.id),
      messages: d.prepare(\"SELECT count(*) n FROM messages\").get().n,
      live_sessions: d.prepare(\"SELECT s.id_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.expires_at > ? ORDER BY s.id_hash\").all(now).map(r => r.id_hash.slice(0, 12)),
      agents: d.prepare(\"SELECT id FROM agents WHERE revoked_at IS NULL ORDER BY id\").all().map(r => r.id)
    }));'"
}
