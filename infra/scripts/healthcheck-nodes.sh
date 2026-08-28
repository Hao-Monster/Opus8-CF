#!/usr/bin/env bash
# Real end-to-end VLESS checks. Direct failures can remove a node from
# subscriptions; landing-only failures are reported as degraded.
set -euo pipefail

cd "$(dirname "$0")/../.."

: "${ROOT_DOMAIN:?ROOT_DOMAIN is required}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"

ROOT_DOMAIN="${ROOT_DOMAIN#https://}"
ROOT_DOMAIN="${ROOT_DOMAIN#http://}"
ROOT_DOMAIN="${ROOT_DOMAIN%%/*}"
CONTROL_API="${CONTROL_PLANE_URL:-https://api.${ROOT_DOMAIN}}"
RUN_ID="gh-${GITHUB_RUN_ID:-manual-$(date +%s)}-${GITHUB_RUN_ATTEMPT:-1}"
WORK_DIR="$(mktemp -d)"
HEALTH_ALERT_FILE="${HEALTH_ALERT_FILE:-${RUNNER_TEMP:-/tmp}/opus8-health-state.json}"
USER_ID=""
ADMIN_TOKEN=""
REMOTE_READY=0
REMOTE_SMOKE_PATH=""
SSH_BASE=()
SCP_BASE=()

cleanup() {
  if [ -n "$USER_ID" ] && [ -n "$ADMIN_TOKEN" ]; then
    curl -fsS --max-time 20 -X DELETE \
      "$CONTROL_API/api/users/$USER_ID" \
      -H "authorization: Bearer $ADMIN_TOKEN" >/dev/null 2>&1 || true
  fi
  if [ "$REMOTE_READY" = "1" ] && [ -n "$REMOTE_SMOKE_PATH" ]; then
    "${SSH_BASE[@]}" "rm -f -- '$REMOTE_SMOKE_PATH'" >/dev/null 2>&1 || true
  fi
  case "$WORK_DIR" in
    /tmp/*) rm -rf -- "$WORK_DIR" ;;
  esac
}
trap cleanup EXIT

echo "STEP login"
LOGIN_RESPONSE="$(curl -fsS --max-time 20 -X POST \
  "$CONTROL_API/api/admin/login" \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg password "$ADMIN_PASSWORD" '{password:$password}')")"
ADMIN_TOKEN="$(printf '%s' "$LOGIN_RESPONSE" | jq -er '.token')"
echo "::add-mask::$ADMIN_TOKEN"
echo "OK login"

echo "STEP prepare-vantages"
VPS_SSH_PORT="${VPS_SSH_PORT:-22}"
if [ -n "${VPS_HOST:-}" ] &&
  [ -n "${VPS_SSH_USER:-}" ] &&
  [ -n "${VPS_SSH_PASSWORD:-}" ] &&
  command -v sshpass >/dev/null 2>&1; then
  export SSHPASS="$VPS_SSH_PASSWORD"
  SSH_BASE=(
    sshpass -e ssh
    -p "$VPS_SSH_PORT"
    -o ConnectTimeout=12
    -o StrictHostKeyChecking=accept-new
    -o ServerAliveInterval=10
    -o ServerAliveCountMax=2
    "$VPS_SSH_USER@$VPS_HOST"
  )
  SCP_BASE=(
    sshpass -e scp
    -P "$VPS_SSH_PORT"
    -o ConnectTimeout=12
    -o StrictHostKeyChecking=accept-new
  )
  REMOTE_TAG="$(printf '%s' "${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}" |
    tr -cd 'A-Za-z0-9._-')"
  REMOTE_SMOKE_PATH="/tmp/opus8-smoke-${REMOTE_TAG}.py"
  if "${SSH_BASE[@]}" 'command -v python3 >/dev/null' >/dev/null 2>&1 &&
    "${SCP_BASE[@]}" infra/scripts/smoke-vless.py \
      "$VPS_SSH_USER@$VPS_HOST:$REMOTE_SMOKE_PATH" >/dev/null 2>&1; then
    REMOTE_READY=1
    echo "OK vantage=landing-vps"
  else
    echo "WARN vantage=landing-vps unavailable; github-only fail-safe"
  fi
else
  echo "WARN vantage=landing-vps not-configured; github-only fail-safe"
fi
echo "OK vantage=github-runner"

echo "STEP probe-landings"
LANDINGS_RESPONSE="$(curl -fsS --max-time 20 "$CONTROL_API/api/landings" \
  -H "authorization: Bearer $ADMIN_TOKEN")"
mapfile -t LANDINGS < <(
  printf '%s' "$LANDINGS_RESPONSE" |
    jq -r '.landings[] | select(.enabled == true) | @base64'
)
LANDING_RESULTS='[]'
for encoded in "${LANDINGS[@]}"; do
  LANDING="$(printf '%s' "$encoded" | base64 -d)"
  LANDING_ID="$(printf '%s' "$LANDING" | jq -er '.id')"
  LANDING_NAME="$(printf '%s' "$LANDING" | jq -er '.name')"
  PREVIOUS_HEALTH="$(printf '%s' "$LANDING" | jq -er '.health')"
  LANDING_OK=false
  LANDING_LATENCY=null
  LANDING_ERROR=""

  for attempt in 1 2; do
    set +e
    LANDING_HTTP="$(curl -sS --max-time 25 -o "$WORK_DIR/landing.json" \
      -w '%{http_code}' -X POST \
      "$CONTROL_API/api/landings/$LANDING_ID/test" \
      -H "authorization: Bearer $ADMIN_TOKEN")"
    CURL_CODE=$?
    set -e
    if [ "$CURL_CODE" -eq 0 ]; then
      LANDING_RESPONSE="$(cat "$WORK_DIR/landing.json")"
      if printf '%s' "$LANDING_RESPONSE" | jq -e '.ok == true' >/dev/null 2>&1; then
        LANDING_OK=true
        LANDING_LATENCY="$(printf '%s' "$LANDING_RESPONSE" | jq -r '.latencyMs // null')"
        LANDING_ERROR=""
        break
      fi
      LANDING_ERROR="$(printf '%s' "$LANDING_RESPONSE" | jq -r '.error // "SOCKS5 probe failed"' | cut -c1-300)"
    else
      LANDING_ERROR="control API transport error (curl $CURL_CODE, HTTP $LANDING_HTTP)"
    fi
    [ "$attempt" -eq 1 ] && sleep 2
  done

  if [ "$LANDING_OK" = true ]; then
    CURRENT_HEALTH=healthy
    echo "OK landing name=$LANDING_NAME latencyMs=$LANDING_LATENCY"
  else
    CURRENT_HEALTH=unhealthy
    echo "WARN landing name=$LANDING_NAME reason=$LANDING_ERROR"
  fi
  [ "$PREVIOUS_HEALTH" = "$CURRENT_HEALTH" ] && LANDING_TRANSITION=false || LANDING_TRANSITION=true
  LANDING_RESULTS="$(printf '%s' "$LANDING_RESULTS" | jq -c \
    --arg id "$LANDING_ID" \
    --arg name "$LANDING_NAME" \
    --arg previousHealth "$PREVIOUS_HEALTH" \
    --arg health "$CURRENT_HEALTH" \
    --argjson ok "$LANDING_OK" \
    --argjson latencyMs "$LANDING_LATENCY" \
    --arg error "$LANDING_ERROR" \
    --argjson transition "$LANDING_TRANSITION" \
    '. + [{
      id:$id,
      name:$name,
      enabled:true,
      previousHealth:$previousHealth,
      health:$health,
      ok:$ok,
      latencyMs:$latencyMs,
      error:(if $error == "" then null else $error end),
      transition:$transition
    }]')"
done
echo "OK enabled-landings count=${#LANDINGS[@]}"

echo "STEP create-isolated-probe-user"
PROBE_USERNAME="__healthcheck__-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}"
CREATE_RESPONSE="$(curl -fsS --max-time 30 -X POST \
  "$CONTROL_API/api/users" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  --data "$(jq -nc \
    --arg username "$PROBE_USERNAME" \
    '{username:$username,durationDays:1,unlock:true,deviceLimit:20,ipLimit24h:100}')")"
USER_ID="$(printf '%s' "$CREATE_RESPONSE" | jq -er '.user.id')"
PROBE_UUID="$(printf '%s' "$CREATE_RESPONSE" | jq -er '.credential.uuid')"
echo "::add-mask::$USER_ID"
echo "::add-mask::$PROBE_UUID"
echo "OK probe-user-created"

# User mutations publish cache invalidations to every registered node. A short
# grace period also covers eventual propagation between Cloudflare locations.
sleep 8

NODES_RESPONSE="$(curl -fsS --max-time 20 "$CONTROL_API/api/nodes" \
  -H "authorization: Bearer $ADMIN_TOKEN")"
mapfile -t NODES < <(
  printf '%s' "$NODES_RESPONSE" |
    jq -er '.nodes[] | select(.enabled == 1) | [.id,.hostname,(.transport_path // "/")] | @tsv'
)
if [ "${#NODES[@]}" -eq 0 ]; then
  echo "ERROR no-enabled-nodes"
  exit 10
fi
echo "OK enabled-nodes count=${#NODES[@]}"

local_probe() {
  local node_id="$1" probe_name="$2" host="$3" transport_path="$4" target="$5"
  local attempt started ended code log_file
  PROBE_OK=false
  PROBE_LATENCY=null
  PROBE_ERROR=""
  log_file="$WORK_DIR/probe.log"

  for attempt in 1 2; do
    started="$(date +%s%3N)"
    set +e
    python3 infra/scripts/smoke-vless.py \
      --url "wss://${host}${transport_path}?ed=2560" \
      --uuid "$PROBE_UUID" \
      --target "$target" \
      --target-port 80 \
      --expect-status 0 \
      --timeout 18 >"$log_file" 2>&1
    code=$?
    set -e
    ended="$(date +%s%3N)"
    if [ "$code" -eq 0 ]; then
      PROBE_OK=true
      PROBE_LATENCY=$((ended - started))
      PROBE_ERROR=""
      echo "OK probe node=$node_id route=$probe_name latencyMs=$PROBE_LATENCY"
      return
    fi
    PROBE_ERROR="$(tail -n 1 "$log_file" | tr '\r\n\t' ' ' | cut -c1-300)"
    [ "$attempt" -eq 1 ] && sleep 2
  done
  echo "WARN probe node=$node_id route=$probe_name reason=$PROBE_ERROR"
}

remote_probe() {
  local node_id="$1" probe_name="$2" host="$3" transport_path="$4" target="$5"
  local attempt started ended code log_file remote_command
  REMOTE_PROBE_OK=false
  REMOTE_PROBE_LATENCY=null
  REMOTE_PROBE_ERROR="vantage unavailable"
  [ "$REMOTE_READY" = "1" ] || return 0
  log_file="$WORK_DIR/remote-probe.log"

  for attempt in 1 2; do
    started="$(date +%s%3N)"
    printf -v remote_command '%q ' \
      python3 "$REMOTE_SMOKE_PATH" \
      --url "wss://${host}${transport_path}?ed=2560" \
      --uuid "$PROBE_UUID" \
      --target "$target" \
      --target-port 80 \
      --expect-status 0 \
      --timeout 18
    set +e
    "${SSH_BASE[@]}" "$remote_command" >"$log_file" 2>&1
    code=$?
    set -e
    ended="$(date +%s%3N)"
    if [ "$code" -eq 0 ]; then
      REMOTE_PROBE_OK=true
      REMOTE_PROBE_LATENCY=$((ended - started))
      REMOTE_PROBE_ERROR=""
      echo "OK probe node=$node_id route=$probe_name vantage=landing-vps latencyMs=$REMOTE_PROBE_LATENCY"
      return
    fi
    REMOTE_PROBE_ERROR="$(tail -n 1 "$log_file" | tr '\r\n\t' ' ' | cut -c1-300)"
    [ "$attempt" -eq 1 ] && sleep 2
  done
  echo "WARN probe node=$node_id route=$probe_name vantage=landing-vps reason=$REMOTE_PROBE_ERROR"
}

aggregate_probe() {
  local node_id="$1" probe_name="$2" host="$3" transport_path="$4" target="$5"
  local github_ok github_latency github_error remote_ok remote_latency remote_error

  local_probe "$node_id" "$probe_name" "$host" "$transport_path" "$target"
  github_ok="$PROBE_OK"
  github_latency="$PROBE_LATENCY"
  github_error="$PROBE_ERROR"
  remote_probe "$node_id" "$probe_name" "$host" "$transport_path" "$target"
  remote_ok="$REMOTE_PROBE_OK"
  remote_latency="$REMOTE_PROBE_LATENCY"
  remote_error="$REMOTE_PROBE_ERROR"

  AGGREGATE_OK="$github_ok"
  AGGREGATE_LATENCY="$github_latency"
  AGGREGATE_ERROR="$github_error"
  if [ "$REMOTE_READY" = "1" ]; then
    if [ "$github_ok" = true ] || [ "$remote_ok" = true ]; then
      AGGREGATE_OK=true
      AGGREGATE_ERROR=""
      if [ "$github_ok" = true ] && [ "$remote_ok" = true ]; then
        [ "$remote_latency" -lt "$github_latency" ] &&
          AGGREGATE_LATENCY="$remote_latency"
      elif [ "$remote_ok" = true ]; then
        AGGREGATE_LATENCY="$remote_latency"
        echo "WARN probe-partial node=$node_id route=$probe_name failed=github-runner"
      else
        echo "WARN probe-partial node=$node_id route=$probe_name failed=landing-vps"
      fi
    else
      AGGREGATE_OK=false
      AGGREGATE_LATENCY=null
      AGGREGATE_ERROR="github-runner: ${github_error}; landing-vps: ${remote_error}"
    fi
  fi

  AGGREGATE_VANTAGES="$(jq -nc \
    --argjson githubOk "$github_ok" \
    --argjson githubLatencyMs "$github_latency" \
    --arg githubError "$github_error" \
    --argjson remoteAvailable "$([ "$REMOTE_READY" = "1" ] && echo true || echo false)" \
    --argjson remoteOk "$remote_ok" \
    --argjson remoteLatencyMs "$remote_latency" \
    --arg remoteError "$remote_error" \
    '{
      github:{
        available:true,
        ok:$githubOk,
        latencyMs:$githubLatencyMs,
        error:(if $githubError == "" then null else $githubError end)
      },
      landingVps:{
        available:$remoteAvailable,
        ok:(if $remoteAvailable then $remoteOk else null end),
        latencyMs:(if $remoteAvailable then $remoteLatencyMs else null end),
        error:(if $remoteAvailable and $remoteError != "" then $remoteError else null end)
      }
    }')"
}

RESULTS='[]'
for entry in "${NODES[@]}"; do
  IFS=$'\t' read -r NODE_ID NODE_HOST NODE_TRANSPORT_PATH <<<"$entry"

  aggregate_probe "$NODE_ID" direct "$NODE_HOST" "$NODE_TRANSPORT_PATH" example.com
  DIRECT_OK="$AGGREGATE_OK"
  DIRECT_LATENCY="$AGGREGATE_LATENCY"
  DIRECT_ERROR="$AGGREGATE_ERROR"
  DIRECT_VANTAGES="$AGGREGATE_VANTAGES"

  aggregate_probe "$NODE_ID" landing "$NODE_HOST" "$NODE_TRANSPORT_PATH" openai.com
  LANDING_OK="$AGGREGATE_OK"
  LANDING_LATENCY="$AGGREGATE_LATENCY"
  LANDING_ERROR="$AGGREGATE_ERROR"
  LANDING_VANTAGES="$AGGREGATE_VANTAGES"

  RESULTS="$(printf '%s' "$RESULTS" | jq -c \
    --arg nodeId "$NODE_ID" \
    --argjson directOk "$DIRECT_OK" \
    --argjson landingOk "$LANDING_OK" \
    --argjson directLatencyMs "$DIRECT_LATENCY" \
    --argjson landingLatencyMs "$LANDING_LATENCY" \
    --arg directError "$DIRECT_ERROR" \
    --arg landingError "$LANDING_ERROR" \
    --argjson directVantages "$DIRECT_VANTAGES" \
    --argjson landingVantages "$LANDING_VANTAGES" \
    '. + [{
      nodeId:$nodeId,
      directOk:$directOk,
      landingOk:$landingOk,
      directLatencyMs:$directLatencyMs,
      landingLatencyMs:$landingLatencyMs,
      directError:(if $directError == "" then null else $directError end),
      landingError:(if $landingError == "" then null else $landingError end),
      vantages:{
        direct:$directVantages,
        landing:$landingVantages
      }
    }]')"
done

echo "STEP report-health"
REPORT_BODY="$(jq -nc \
  --arg runId "$RUN_ID" \
  --argjson checkedAt "$(date +%s)000" \
  --argjson results "$RESULTS" \
  '{runId:$runId,checkedAt:$checkedAt,results:$results}')"
REPORT_RESPONSE="$(curl -fsS --max-time 30 \
  --retry 4 --retry-delay 2 --retry-all-errors -X POST \
  "$CONTROL_API/api/operations/node-health/report" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  --data "$REPORT_BODY")"
printf '%s' "$REPORT_RESPONSE" | jq -e '.ok == true' >/dev/null
echo "OK health-reported run=$RUN_ID"

mkdir -p "$(dirname "$HEALTH_ALERT_FILE")"
jq -nc \
  --argjson generatedAt "$(date +%s)000" \
  --argjson report "$REPORT_RESPONSE" \
  --argjson landings "$LANDING_RESULTS" \
  '{
    generatedAt:$generatedAt,
    runId:$report.runId,
    summary:$report.summary,
    transitions:$report.transitions,
    nodes:$report.nodes,
    landings:$landings
  }' >"$HEALTH_ALERT_FILE"

HEALTHY="$(printf '%s' "$REPORT_RESPONSE" | jq -r '.summary.healthy')"
DEGRADED="$(printf '%s' "$REPORT_RESPONSE" | jq -r '.summary.degraded')"
BANNED="$(printf '%s' "$REPORT_RESPONSE" | jq -r '.summary.banned')"
TRANSITIONS="$(printf '%s' "$REPORT_RESPONSE" | jq -r '.transitions | length')"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Opus8 node health"
    echo
    echo "- Run: \`$RUN_ID\`"
    echo "- Healthy: $HEALTHY"
    echo "- Degraded: $DEGRADED"
    echo "- Removed from subscriptions: $BANNED"
    echo "- State transitions: $TRANSITIONS"
    echo "- Healthy landings: $(printf '%s' "$LANDING_RESULTS" | jq '[.[] | select(.health == "healthy")] | length') / ${#LANDINGS[@]}"
    echo
    echo "| Node | Direct | Landing / WARP | State |"
    echo "| --- | --- | --- | --- |"
    printf '%s' "$REPORT_RESPONSE" | jq -r '
      .nodes[] |
      "| \(.id) | " +
      (if .health_direct_ok == 1 then "OK \(.health_direct_latency_ms // "-") ms" else "FAIL" end) +
      " | " +
      (if .health_landing_ok == 1 then "OK \(.health_landing_latency_ms // "-") ms" else "FAIL" end) +
      " | \(.health) |"'
    echo
    echo "| Landing | SOCKS5 | State |"
    echo "| --- | --- | --- |"
    printf '%s' "$LANDING_RESULTS" | jq -r '
      .[] |
      "| \(.name) | " +
      (if .ok then "OK \(.latencyMs // "-") ms" else (.error // "FAIL") end) +
      " | \(.health) |"'
  } >>"$GITHUB_STEP_SUMMARY"
fi

if [ "$BANNED" -gt 0 ]; then
  echo "::warning::$BANNED node(s) are currently removed from subscriptions"
elif [ "$DEGRADED" -gt 0 ]; then
  echo "::warning::$DEGRADED node(s) are currently degraded"
fi
echo "DONE healthy=$HEALTHY degraded=$DEGRADED banned=$BANNED"
