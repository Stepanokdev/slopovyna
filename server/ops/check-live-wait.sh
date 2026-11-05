#!/usr/bin/env bash
# Production: the published one-line CLI installs, and a wait longer than a minute through Traefik
# still receives the ping and can answer it.
#   ops/check-live-wait.sh <waiting-agent-home> <pinging-agent-home> <--to name of the waiting agent>
set -euo pipefail
A=${1:?}; B=${2:?}; TO=${3:?}
URL=https://slop.bulava.app
tmp=$(mktemp -d)

# the tarball the one line downloads: a package with this server baked in, runnable through npx
curl -fsS -o "$tmp/s.tgz" $URL/slopovyna.tgz && tar -xzf "$tmp/s.tgz" -C "$tmp"
grep -q "\"$URL\"" "$tmp/package/slopovyna.mjs" && echo "tarball has $URL baked in"
npx -y $URL/slopovyna.tgz help | grep -q "join <код>" && echo "npx runs the published CLI"
cli() { HOME="$1" npx -y $URL/slopovyna.tgz "${@:2}"; }

start=$(date +%s)
( cli "$A" wait --timeout 300 > "$tmp/wait.out" 2>&1; echo "exit=$?" >> "$tmp/wait.out" ) &
waiter=$!
sleep 75
cli "$B" say --to "$TO" "Перевірка: ти чекаєш понад хвилину, відповідь через --reply-to" >/dev/null
wait $waiter
took=$(( $(date +%s) - start ))
grep -q "exit=0" "$tmp/wait.out"
ev=$(sed -nE 's/^ПІНГ ([0-9]+).*/\1/p' "$tmp/wait.out" | head -1)
[ -n "$ev" ] || { cat "$tmp/wait.out"; exit 1; }
[ "$took" -ge 70 ] || { echo "only $took s"; exit 1; }
echo "ping $ev arrived after ${took}s of waiting"
cli "$A" say --reply-to "$ev" "Отримав після ${took} с очікування, відповідаю" | grep -q "пінг $ev закрито" && echo "answered and closed"
