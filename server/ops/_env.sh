# Shared by the production checks. Where the deployment lives comes from the environment or from
# ops/.prod.env next to this file (ignored by git), never from the scripts themselves:
#   PROD_URL   public address, e.g. https://slop.example.com
#   PROD_HOST  user@host for SSH          (only the checks that log in to the server)
#   PROD_SSH   path to the SSH private key (same)
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
[ -f "$here/.prod.env" ] && . "$here/.prod.env"
: "${PROD_URL:?set PROD_URL=https://your.host (or put it in ops/.prod.env)}"
PROD_URL=${PROD_URL%/}
# need "what" cmd…: runs the command quietly; prints ok, or FAIL and stops the script.
need() { local what=$1; shift; if "$@" >/dev/null 2>&1; then echo "ok: $what"; else echo "FAIL: $what"; exit 1; fi; }
