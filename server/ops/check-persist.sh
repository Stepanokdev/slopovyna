#!/usr/bin/env bash
# Production: data survives a restart and a full rebuild, and no secret is baked into the image.
#   ops/check-persist.sh <agent-home>      # an agent home whose key was issued before the rebuild
set -euo pipefail
cd "$(dirname "$0")"; . ./_ssh.sh
AGENT_HOME=${1:?agent home}
URL=https://slop.bulava.app

before=$(snapshot); echo "before: $before" | sed -E 's/"live_sessions":\[[^]]*\]/"live_sessions":[…]/'
[ "$(echo "$before" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0));j.rooms.length>0&&j.live_sessions.length>0&&j.agents.length>0')" = true ] || { echo "nothing to compare"; exit 1; }

echo "restart"; prod "docker restart slopovyna >/dev/null"
echo "rebuild"; prod "cd /opt/slopovyna && docker compose up -d --build --force-recreate >/dev/null 2>&1"
for i in $(seq 1 30); do [ "$(prod "docker inspect -f '{{.State.Health.Status}}' slopovyna")" = healthy ] && break; sleep 2; done
[ "$(curl -fsS $URL/healthz)" = ok ]

after=$(snapshot)
[ "$before" = "$after" ] || { echo "after: $after"; echo "DATA CHANGED"; exit 1; }
echo "rooms, messages, live sessions and agents are the same after restart and rebuild"

# the agent key issued before the rebuild still works, through the published CLI
HOME="$AGENT_HOME" npx -y $URL/slopovyna.tgz who >/dev/null && echo "agent key works after rebuild"

# secrets: not in the image config, not in any layer, not in any file of the image, not in the code dir
prod 'set -e; img=$(docker inspect -f "{{.Image}}" slopovyna); env=/opt/slopovyna-secrets/slopovyna.env
  [ "$(stat -c %a $env)" = 600 ]
  for k in GITHUB_CLIENT_SECRET SLOP_SECRET; do
    v=$(grep "^$k=" $env | cut -d= -f2-); [ -n "$v" ]
    docker image inspect $img --format "{{json .Config.Env}}" | grep -qF "$v" && { echo "$k in image env"; exit 1; }
    docker history --no-trunc $img | grep -qF "$v" && { echo "$k in a layer"; exit 1; }
    docker run --rm --entrypoint sh $img -c "grep -rqsF -- \"$v\" /app /data /etc" && { echo "$k in image files"; exit 1; }
    grep -rqsF -- "$v" /opt/slopovyna && { echo "$k in code dir"; exit 1; }
  done; echo "secrets only in $env (600)"'
