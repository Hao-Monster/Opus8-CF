#!/usr/bin/env bash
# Discover Cloudflare anycast candidates and publish a separate, expiring IP
# pool for each node. Every published node/IP pair must pass a real VLESS test
# from both GitHub and the landing VPS.
set -euo pipefail

WS="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$WS"

: "${CONTROL_PLANE_URL:?CONTROL_PLANE_URL is required}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"

for command in curl jq node python3 sha256sum tar; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "ERROR missing-command=$command"
    exit 2
  }
done

VPS_SSH_PORT="${VPS_SSH_PORT:-22}"
VPS_HOST="${VPS_HOST:-}"
VPS_SSH_USER="${VPS_SSH_USER:-}"
VPS_SSH_PASSWORD="${VPS_SSH_PASSWORD:-}"
LANDING_SOCKS_HOST="${LANDING_SOCKS_HOST:-${VPS_HOST:-}}"
LANDING_SOCKS_PORT="${LANDING_SOCKS_PORT:-}"
LANDING_SOCKS_USER="${LANDING_SOCKS_USER:-}"
LANDING_SOCKS_PASSWORD="${LANDING_SOCKS_PASSWORD:-}"
SUB_MAX_OPTIMIZED_IPS_PER_NODE="${SUB_MAX_OPTIMIZED_IPS_PER_NODE:-8}"
if ! printf '%s' "$SUB_MAX_OPTIMIZED_IPS_PER_NODE" | grep -qE '^[1-8]$'; then
  echo "ERROR invalid-sub-max-optimized-ips-per-node"
  exit 2
fi
WORK_DIR="$(mktemp -d)"
ADMIN_TOKEN=""
USER_ID=""
REMOTE_READY=0
REMOTE_MODE=""
REMOTE_SMOKE_PATH=""
SSH_BASE=()
SCP_BASE=()

cleanup() {
  if [ -n "$USER_ID" ] && [ -n "$ADMIN_TOKEN" ]; then
    curl -fsS --max-time 20 -X DELETE \
      "$CONTROL_PLANE_URL/api/users/$USER_ID" \
      -H "authorization: Bearer $ADMIN_TOKEN" >/dev/null 2>&1 || true
  fi
  if [ "$REMOTE_MODE" = "ssh" ] && [ -n "$REMOTE_SMOKE_PATH" ]; then
    "${SSH_BASE[@]}" "rm -f -- '$REMOTE_SMOKE_PATH'" >/dev/null 2>&1 || true
  fi
  case "$WORK_DIR" in
    /tmp/*) rm -rf -- "$WORK_DIR" ;;
  esac
}
trap cleanup EXIT

echo "STEP prepare-vantages"
REMOTE_TAG="$(printf '%s' "${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}" |
  tr -cd 'A-Za-z0-9._-')"
REMOTE_SMOKE_PATH="/tmp/opus8-optimize-smoke-${REMOTE_TAG}.py"

if [ -n "$LANDING_SOCKS_HOST" ] \
  && [ -n "$LANDING_SOCKS_PORT" ] \
  && [ -n "$LANDING_SOCKS_USER" ] \
  && [ -n "$LANDING_SOCKS_PASSWORD" ]; then
  if ! printf '%s' "$LANDING_SOCKS_PORT" | grep -qE '^[1-9][0-9]{0,4}$' \
    || [ "$LANDING_SOCKS_PORT" -gt 65535 ]; then
    echo "ERROR invalid-landing-socks-port"
    exit 10
  fi
  LANDING_PROXY_IP=$(curl -fsS --connect-timeout 8 --max-time 15 \
    --proxy "socks5h://${LANDING_SOCKS_HOST}:${LANDING_SOCKS_PORT}" \
    --proxy-user "${LANDING_SOCKS_USER}:${LANDING_SOCKS_PASSWORD}" \
    https://api.ipify.org 2>/dev/null || true)
  if printf '%s' "$LANDING_PROXY_IP" \
    | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
    REMOTE_READY=1
    REMOTE_MODE=socks5
    echo "OK landing-vantage mode=socks5"
  else
    echo "WARN landing-socks-vantage-unavailable"
  fi
else
  echo "WARN landing-socks-vantage-not-configured"
fi
unset LANDING_PROXY_IP

if [ "$REMOTE_READY" != "1" ] \
  && [ -n "$VPS_HOST" ] \
  && [ -n "$VPS_SSH_USER" ] \
  && [ -n "$VPS_SSH_PASSWORD" ] \
  && command -v sshpass >/dev/null 2>&1; then
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
  if "${SSH_BASE[@]}" 'command -v python3 >/dev/null' >/dev/null 2>&1 \
    && "${SCP_BASE[@]}" infra/scripts/smoke-vless.py \
      "$VPS_SSH_USER@$VPS_HOST:$REMOTE_SMOKE_PATH" >/dev/null 2>&1; then
    REMOTE_READY=1
    REMOTE_MODE=ssh
    echo "OK landing-vantage mode=ssh"
  fi
fi
if [ "$REMOTE_READY" != "1" ]; then
  echo "ERROR landing-vps-vantage-unavailable"
  exit 10
fi
echo "OK vantages=github-runner,landing-vps mode=$REMOTE_MODE"

echo "STEP login"
LOGIN_RESPONSE="$(curl -fsS --max-time 20 -X POST \
  "$CONTROL_PLANE_URL/api/admin/login" \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg password "$ADMIN_PASSWORD" '{password:$password}')")"
ADMIN_TOKEN="$(printf '%s' "$LOGIN_RESPONSE" | jq -er '.token')"
echo "::add-mask::$ADMIN_TOKEN"
echo "OK login"

echo "STEP eligible-nodes"
NODES_RESPONSE="$(curl -fsS --max-time 20 "$CONTROL_PLANE_URL/api/nodes" \
  -H "authorization: Bearer $ADMIN_TOKEN")"
mapfile -t NODES < <(
  printf '%s' "$NODES_RESPONSE" |
    jq -er '
      [.nodes[] | select(.enabled == 1 and .health != "banned")] |
      sort_by(.account_alias,.id) |
      .[] |
      [.id,.hostname,(.transport_path // "/")] | @tsv'
)
if [ "${#NODES[@]}" -eq 0 ]; then
  echo "ERROR no-eligible-nodes"
  exit 11
fi
echo "OK eligible-nodes count=${#NODES[@]}"

echo "STEP create-isolated-probe-user"
PROBE_USERNAME="__optimize__-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}"
CREATE_RESPONSE="$(curl -fsS --max-time 30 -X POST \
  "$CONTROL_PLANE_URL/api/users" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  --data "$(jq -nc \
    --arg username "$PROBE_USERNAME" \
    '{username:$username,durationDays:1,unlock:true,deviceLimit:20,ipLimit24h:100}')")"
USER_ID="$(printf '%s' "$CREATE_RESPONSE" | jq -er '.user.id')"
PROBE_UUID="$(printf '%s' "$CREATE_RESPONSE" | jq -er '.credential.uuid')"
PROBE_SUB_URL="$(printf '%s' "$CREATE_RESPONSE" | jq -er '.subUrl')"
echo "::add-mask::$USER_ID"
echo "::add-mask::$PROBE_UUID"
echo "::add-mask::$PROBE_SUB_URL"
echo "OK probe-user-created"
sleep 8

local_smoke() {
  local node_host="$1" transport_path="$2" connect_host="${3:-}" log_file="$4"
  local args=(
    python3 infra/scripts/smoke-vless.py
    --url "wss://${node_host}${transport_path}?ed=2560"
    --uuid "$PROBE_UUID"
    --target example.com
    --target-port 80
    --expect-status 0
    --timeout 12
    --json
  )
  [ -n "$connect_host" ] && args+=(--connect-host "$connect_host")
  "${args[@]}" >"$log_file" 2>&1
}

remote_smoke() {
  local node_host="$1" transport_path="$2" connect_host="${3:-}" log_file="$4"
  local args=(
    python3 infra/scripts/smoke-vless.py
    --url "wss://${node_host}${transport_path}?ed=2560"
    --uuid "$PROBE_UUID"
    --target example.com
    --target-port 80
    --expect-status 0
    --timeout 12
    --json
  )
  [ -n "$connect_host" ] && args+=(--connect-host "$connect_host")
  if [ "$REMOTE_MODE" = "socks5" ]; then
    args+=(
      --proxy-host "$LANDING_SOCKS_HOST"
      --proxy-port "$LANDING_SOCKS_PORT"
      --proxy-username-env OPUS8_SMOKE_PROXY_USERNAME
      --proxy-password-env OPUS8_SMOKE_PROXY_PASSWORD
    )
    OPUS8_SMOKE_PROXY_USERNAME="$LANDING_SOCKS_USER" \
      OPUS8_SMOKE_PROXY_PASSWORD="$LANDING_SOCKS_PASSWORD" \
      "${args[@]}" >"$log_file" 2>&1
    return
  fi
  args[1]="$REMOTE_SMOKE_PATH"
  local remote_command
  printf -v remote_command '%q ' "${args[@]}"
  "${SSH_BASE[@]}" "$remote_command" >"$log_file" 2>&1
}

echo "STEP verify-domain-baseline"
BASELINE_NODES=()
for entry in "${NODES[@]}"; do
  IFS=$'\t' read -r node_id node_host transport_path <<<"$entry"
  baseline_ok=0
  : >"$WORK_DIR/domain-local.log"
  : >"$WORK_DIR/domain-remote.log"
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if local_smoke "$node_host" "$transport_path" "" "$WORK_DIR/domain-local.log" &&
      remote_smoke "$node_host" "$transport_path" "" "$WORK_DIR/domain-remote.log"; then
      baseline_ok=1
      break
    fi
    [ "$attempt" -lt 12 ] && sleep 5
  done
  if [ "$baseline_ok" != "1" ]; then
    local_reason="$(tail -n 1 "$WORK_DIR/domain-local.log" 2>/dev/null |
      tr '\r\n\t' ' ' |
      cut -c1-180 || true)"
    remote_reason="$(tail -n 1 "$WORK_DIR/domain-remote.log" 2>/dev/null |
      tr '\r\n\t' ' ' |
      cut -c1-180 || true)"
    echo "WARN domain-baseline node=$node_id skipped=1 github=${local_reason:-unknown} vps=${remote_reason:-unknown}"
    continue
  fi
  BASELINE_NODES+=("$entry")
  echo "OK domain-baseline node=$node_id vantages=2"
done
if [ "${#BASELINE_NODES[@]}" -eq 0 ]; then
  POOL_RESPONSE="$(curl -fsS --max-time 20 \
    "$CONTROL_PLANE_URL/api/optimized-ips" \
    -H "authorization: Bearer $ADMIN_TOKEN")"
  ACTIVE_COUNT="$(printf '%s' "$POOL_RESPONSE" | jq -r '.ips | length')"
  echo "OK no-two-vantage-baseline domain-fallback=active existingActivePool=$ACTIVE_COUNT"
  echo "DONE publishedNodes=0 publishedIps=0"
  exit 0
fi

echo "STEP discover-cfst-candidates"
RAW_IPS="$WORK_DIR/raw-ips.txt"
if [ -s "$WS/infra/optimized-ips.txt" ]; then
  sed 's/#.*//' "$WS/infra/optimized-ips.txt" >"$RAW_IPS"
  echo "OK candidate-source=custom-list"
else
  CFST_MANIFEST="$WS/infra/cfst-tool.json"
  if ! jq -e '
    .schemaVersion == 1 and
    .platform == "linux-amd64" and
    (.version | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    .releaseTag == ("v" + .version) and
    .asset == "cfst_linux_amd64.tar.gz" and
    .url == (
      "https://github.com/XIU2/CloudflareSpeedTest/releases/download/" +
      .releaseTag + "/" + .asset
    ) and
    (.sha256 | test("^[a-f0-9]{64}$"))
  ' "$CFST_MANIFEST" >/dev/null; then
    echo "ERROR invalid-cfst-manifest"
    exit 12
  fi
  CFST_VERSION="$(jq -er '.version' "$CFST_MANIFEST")"
  CFST_URL="$(jq -er '.url' "$CFST_MANIFEST")"
  CFST_SHA256="$(jq -er '.sha256' "$CFST_MANIFEST")"
  if ! curl -fsSL --retry 4 --retry-delay 2 --retry-all-errors \
    --connect-timeout 20 --max-time 240 \
    "$CFST_URL" -o "$WORK_DIR/cfst.tgz"; then
    echo "ERROR cfst-download"
    exit 12
  fi
  if ! printf '%s  %s\n' "$CFST_SHA256" "$WORK_DIR/cfst.tgz" \
    | sha256sum -c - >/dev/null; then
    echo "ERROR cfst-checksum"
    exit 12
  fi
  mkdir -p "$WORK_DIR/cfst"
  tar xzf "$WORK_DIR/cfst.tgz" -C "$WORK_DIR/cfst"
  BIN="$(find "$WORK_DIR/cfst" -maxdepth 3 -type f |
    grep -iE '(cloudflarest|cfst)$' |
    head -n1 || true)"
  if [ -z "$BIN" ]; then
    echo "ERROR cfst-binary-not-found"
    find "$WORK_DIR/cfst" -maxdepth 3 -type f -printf 'INFO archive-file=%P\n' |
      head -n 20
    exit 12
  fi
  chmod +x "$BIN"
  if ! curl -fsSL https://www.cloudflare.com/ips-v4 \
    -o "$WORK_DIR/cfst/ip.txt"; then
    echo "ERROR cloudflare-ip-ranges-download"
    exit 13
  fi
  if ! (
    cd "$WORK_DIR/cfst"
    "$BIN" -dd -tp 443 -n 200 -t 4 -o result.csv
  ) >"$WORK_DIR/cfst.log" 2>&1; then
    echo "ERROR speedtest"
    tail -n 5 "$WORK_DIR/cfst.log"
    exit 13
  fi
  tail -n +2 "$WORK_DIR/cfst/result.csv" | cut -d, -f1 >"$RAW_IPS"
  echo "OK candidate-source=cfst version=$CFST_VERSION sha256=verified"
fi

mapfile -t CFST_CANDIDATES < <(
  python3 - "$RAW_IPS" <<'PY'
import ipaddress
import sys

seen = set()
for raw in open(sys.argv[1], encoding="utf-8"):
    candidate = raw.strip()
    try:
        address = ipaddress.ip_address(candidate)
    except ValueError:
        continue
    if address.version != 4 or candidate in seen:
        continue
    seen.add(candidate)
    print(candidate)
    if len(seen) >= 64:
        break
PY
)
echo "OK cfst-candidates count=${#CFST_CANDIDATES[@]}"

local_candidate_ok() {
  local ip="$1" node_id="$2" node_host="$3" transport_path="$4" log_file="$5" reason
  if local_smoke "$node_host" "$transport_path" "$ip" "$log_file"; then
    return 0
  fi
  reason="$(tail -n 1 "$log_file" |
    tr '\r\n\t' ' ' |
    cut -c1-240)"
  echo "WARN candidate=$ip vantage=github-runner node=$node_id reason=$reason"
  return 1
}

remote_candidate_ok() {
  local ip="$1" node_id="$2" node_host="$3" transport_path="$4" log_file="$5" reason
  if remote_smoke "$node_host" "$transport_path" "$ip" "$log_file"; then
    return 0
  fi
  reason="$(tail -n 1 "$log_file" |
    tr '\r\n\t' ' ' |
    cut -c1-240)"
  echo "WARN candidate=$ip vantage=landing-vps node=$node_id reason=$reason"
  return 1
}

echo "STEP validate-node-candidates"
SAFE_NODE_IPS='{}'
SAFE_NODE_COUNT=0
SAFE_IP_COUNT=0
for entry in "${BASELINE_NODES[@]}"; do
  IFS=$'\t' read -r node_id node_host transport_path <<<"$entry"
  NODE_RAW="$WORK_DIR/node-${node_id}-candidates.txt"
  : >"$NODE_RAW"
  getent ahostsv4 "$node_host" 2>/dev/null |
    awk '{print $1}' >>"$NODE_RAW" || true
  if [ "$REMOTE_MODE" = "ssh" ]; then
    "${SSH_BASE[@]}" "getent ahostsv4 '$node_host' 2>/dev/null | tr -s ' ' | cut -d' ' -f1" \
      >>"$NODE_RAW" 2>/dev/null || true
  fi
  printf '%s\n' "${CFST_CANDIDATES[@]}" >>"$NODE_RAW"

  mapfile -t NODE_CANDIDATES < <(
    python3 - "$NODE_RAW" <<'PY'
import ipaddress
import sys

seen = set()
for raw in open(sys.argv[1], encoding="utf-8"):
    candidate = raw.strip()
    try:
        address = ipaddress.ip_address(candidate)
    except ValueError:
        continue
    if address.version != 4 or candidate in seen:
        continue
    seen.add(candidate)
    print(candidate)
    if len(seen) >= 32:
        break
PY
  )
  echo "OK node-candidates node=$node_id count=${#NODE_CANDIDATES[@]}"

  VALIDATED=()
  NODE_RESULTS="$WORK_DIR/node-${node_id}-results"
  mkdir -p "$NODE_RESULTS"
  SELECTED_JSON='[]'
  PROBE_TARGET=8
  PROBE_BATCH_SIZE=4
  candidate_index=0
  while [ "$candidate_index" -lt "${#NODE_CANDIDATES[@]}" ]; do
    probe_pids=()
    for offset in $(seq 0 $((PROBE_BATCH_SIZE - 1))); do
      index=$((candidate_index + offset))
      [ "$index" -lt "${#NODE_CANDIDATES[@]}" ] || break
      ip="${NODE_CANDIDATES[$index]}"
      (
        local_log="$NODE_RESULTS/$index-local.json"
        remote_log="$NODE_RESULTS/$index-remote.json"
        result_file="$NODE_RESULTS/$index.json"
        if local_candidate_ok "$ip" "$node_id" "$node_host" "$transport_path" "$local_log" &&
          remote_candidate_ok "$ip" "$node_id" "$node_host" "$transport_path" "$remote_log"; then
          local_ms="$(jq -er 'select(.ok == true) | .elapsedMs' "$local_log")"
          remote_ms="$(jq -er 'select(.ok == true) | .elapsedMs' "$remote_log")"
          jq -nc \
            --arg ip "$ip" \
            --argjson localMs "$local_ms" \
            --argjson remoteMs "$remote_ms" \
            '{ip:$ip,localMs:$localMs,remoteMs:$remoteMs}' >"$result_file"
          echo "OK candidate=$ip node=$node_id vantages=2 localMs=$local_ms remoteMs=$remote_ms"
        fi
        exit 0
      ) &
      probe_pids+=("$!")
    done
    for probe_pid in "${probe_pids[@]}"; do
      wait "$probe_pid" || true
    done
    SELECTED_JSON="$(node infra/scripts/optimized-ip-selection.mjs \
      "$NODE_RESULTS" "$PROBE_TARGET")"
    [ "$(printf '%s' "$SELECTED_JSON" | jq 'length')" -ge "$PROBE_TARGET" ] && break
    candidate_index=$((candidate_index + PROBE_BATCH_SIZE))
  done
  mapfile -t VALIDATED < <(printf '%s' "$SELECTED_JSON" | jq -r '.[]')
  if [ "${#VALIDATED[@]}" -gt 0 ]; then
    IPS_JSON="$(printf '%s\n' "${VALIDATED[@]}" | jq -R . | jq -sc .)"
    SAFE_NODE_IPS="$(printf '%s' "$SAFE_NODE_IPS" | jq -c \
      --arg nodeId "$node_id" \
      --arg hostname "$node_host" \
      --arg transportPath "$transport_path" \
      --argjson ips "$IPS_JSON" \
      '. + {($nodeId):{hostname:$hostname,transportPath:$transportPath,ips:$ips}}')"
    SAFE_NODE_COUNT=$((SAFE_NODE_COUNT + 1))
    SAFE_IP_COUNT=$((SAFE_IP_COUNT + ${#VALIDATED[@]}))
  else
    echo "OK node-domain-fallback node=$node_id"
  fi
done

if [ "$SAFE_NODE_COUNT" -eq 0 ]; then
  POOL_RESPONSE="$(curl -fsS --max-time 20 \
    "$CONTROL_PLANE_URL/api/optimized-ips" \
    -H "authorization: Bearer $ADMIN_TOKEN")"
  ACTIVE_COUNT="$(printf '%s' "$POOL_RESPONSE" | jq -r '.ips | length')"
  echo "OK no-safe-candidates domain-fallback=active existingActivePool=$ACTIVE_COUNT"
  echo "DONE publishedNodes=0 publishedIps=0"
  exit 0
fi

echo "STEP push-to-control"
NOW_MS="$(date +%s%3N)"
EXPIRES_MS=$((NOW_MS + 12 * 60 * 60 * 1000))
POOL_NODES="$(printf '%s' "$SAFE_NODE_IPS" | jq -c \
  --argjson validatedAt "$NOW_MS" \
  --argjson expiresAt "$EXPIRES_MS" \
  'with_entries(
    .value += {
      validatedAt:$validatedAt,
      expiresAt:$expiresAt,
      vantages:["github-runner","landing-vps"]
    }
  )')"
BODY="$(jq -nc \
  --argjson nodes "$POOL_NODES" \
  '{version:3,nodes:$nodes}')"
RESPONSE="$(curl -fsS --max-time 20 -X POST \
  "$CONTROL_PLANE_URL/api/optimized-ips" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  --data "$BODY")"
printf '%s' "$RESPONSE" | jq -e \
  --argjson nodeCount "$SAFE_NODE_COUNT" \
  '.ok == true and .nodeCount == $nodeCount' >/dev/null
echo "OK pushed nodes=$SAFE_NODE_COUNT ips=$SAFE_IP_COUNT expiresHours=12"

echo "STEP verify-subscription"
printf '%s' "$SAFE_NODE_IPS" >"$WORK_DIR/expected-node-ips.json"
SUBSCRIPTION_VERIFIED=0
for attempt in $(seq 1 12); do
  if curl -fsS --max-time 30 "$PROBE_SUB_URL" \
    | base64 -d >"$WORK_DIR/subscription.txt" \
    && node infra/scripts/verify-optimized-subscription.mjs \
      "$WORK_DIR/subscription.txt" \
      "$WORK_DIR/expected-node-ips.json" \
      "$SUB_MAX_OPTIMIZED_IPS_PER_NODE" \
      >"$WORK_DIR/subscription-verification.json" \
      2>"$WORK_DIR/subscription-verification.log"; then
    SUBSCRIPTION_VERIFIED=1
    break
  fi
  [ "$attempt" -lt 12 ] && sleep 5
done
if [ "$SUBSCRIPTION_VERIFIED" != "1" ]; then
  echo "ERROR subscription-verification"
  tail -n 3 "$WORK_DIR/subscription-verification.log" 2>/dev/null || true
  exit 14
fi
VERIFIED_SUBSCRIPTION_IPS=$(jq -er '.ipCount' \
  "$WORK_DIR/subscription-verification.json")
echo "OK subscription-verified nodes=$SAFE_NODE_COUNT ips=$VERIFIED_SUBSCRIPTION_IPS limit=$SUB_MAX_OPTIMIZED_IPS_PER_NODE"
echo "DONE publishedNodes=$SAFE_NODE_COUNT publishedIps=$SAFE_IP_COUNT"
