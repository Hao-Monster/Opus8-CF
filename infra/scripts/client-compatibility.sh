#!/usr/bin/env bash
# Low-frequency real-client acceptance for one healthy canary node.
# Downloads pinned official cores, compares all four subscription formats,
# opens a real proxied HTTPS request with each core, then verifies usage.
set -euo pipefail

cd "$(dirname "$0")/../.."

: "${ROOT_DOMAIN:?ROOT_DOMAIN is required}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"

for command in curl jq node sha256sum unzip gzip tar install timeout; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "ERROR missing-command=$command"
    exit 2
  }
done

ROOT_DOMAIN="${ROOT_DOMAIN#https://}"
ROOT_DOMAIN="${ROOT_DOMAIN#http://}"
ROOT_DOMAIN="${ROOT_DOMAIN%%/*}"
CONTROL_API="${CONTROL_PLANE_URL:-https://api.${ROOT_DOMAIN}}"
TARGET_URL="${COMPAT_TARGET_URL:-https://example.com/}"
MANIFEST="infra/client-compatibility.json"
WORK_DIR="$(mktemp -d /tmp/opus8-client-compat.XXXXXX)"
BIN_DIR="$WORK_DIR/bin"
SUB_DIR="$WORK_DIR/subscriptions"
CONFIG_DIR="$WORK_DIR/config"
LOG_DIR="$WORK_DIR/logs"
USER_ID=""
USER_IDENTITY_UUID=""
USER_UUID=""
CANARY_USERNAME=""
ADMIN_TOKEN=""
CLIENT_PIDS=()

cleanup() {
  local pid cleanup_response cleanup_id
  for pid in "${CLIENT_PIDS[@]}"; do
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
  done
  if [ -n "$ADMIN_TOKEN" ] &&
    { [ -n "$USER_ID" ] || [ -n "$CANARY_USERNAME" ]; }; then
    cleanup_response="$(curl -fsS --max-time 20 \
      "$CONTROL_API/api/users" \
      -H "authorization: Bearer $ADMIN_TOKEN" 2>/dev/null || true)"
    while IFS= read -r cleanup_id; do
      [ -n "$cleanup_id" ] || continue
      curl -fsS --max-time 20 -X DELETE \
        "$CONTROL_API/api/users/$cleanup_id" \
        -H "authorization: Bearer $ADMIN_TOKEN" >/dev/null 2>&1 || true
    done < <(
      printf '%s' "$cleanup_response" | jq -r \
        --arg id "$USER_ID" \
        --arg username "$CANARY_USERNAME" \
        '.users[]? | select(
          ($id != "" and .id == $id) or
          ($username != "" and .username == $username)
        ) | .id' 2>/dev/null | sort -u
    )
  fi
  case "$WORK_DIR" in
    /tmp/opus8-client-compat.*) rm -rf -- "$WORK_DIR" ;;
  esac
}
trap cleanup EXIT

if ! jq -e '
  .schemaVersion == 1 and
  .platform == "linux-amd64" and
  (.clients | type == "object")
' "$MANIFEST" >/dev/null; then
  echo "ERROR invalid-client-manifest"
  exit 2
fi

case "$TARGET_URL" in
  https://*) ;;
  *)
    echo "ERROR COMPAT_TARGET_URL must use https://"
    exit 2
    ;;
esac

mkdir -p "$BIN_DIR" "$SUB_DIR" "$CONFIG_DIR" "$LOG_DIR"

download_client() {
  local client="$1" version asset url expected archive release_dir binary version_output
  version="$(jq -er --arg client "$client" '.clients[$client].version' "$MANIFEST")"
  asset="$(jq -er --arg client "$client" '.clients[$client].asset' "$MANIFEST")"
  url="$(jq -er --arg client "$client" '.clients[$client].url' "$MANIFEST")"
  expected="$(jq -er --arg client "$client" '.clients[$client].sha256' "$MANIFEST")"
  if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' ||
    ! printf '%s' "$asset" | grep -Eq '^[A-Za-z0-9._-]+$' ||
    ! printf '%s' "$url" | grep -Eq '^https://github\.com/[^/]+/[^/]+/releases/download/' ||
    ! printf '%s' "$expected" | grep -Eq '^[a-f0-9]{64}$'; then
    echo "ERROR invalid-client-manifest-entry client=$client"
    return 2
  fi
  archive="$WORK_DIR/$asset"

  echo "STEP download client=$client version=$version"
  curl -fsSL --retry 4 --retry-delay 2 --retry-all-errors \
    --connect-timeout 20 --max-time 180 \
    "$url" -o "$archive"
  printf '%s  %s\n' "$expected" "$archive" | sha256sum -c - >/dev/null

  case "$client" in
    xray)
      release_dir="$WORK_DIR/xray-release"
      mkdir -p "$release_dir"
      unzip -q "$archive" xray geoip.dat geosite.dat -d "$release_dir"
      install -m 0755 "$release_dir/xray" "$BIN_DIR/xray"
      install -m 0644 "$release_dir/geoip.dat" "$BIN_DIR/geoip.dat"
      install -m 0644 "$release_dir/geosite.dat" "$BIN_DIR/geosite.dat"
      binary="$BIN_DIR/xray"
      version_output="$("$binary" version 2>&1)"
      printf '%s\n' "$version_output" | grep -F "$version" >/dev/null
      ;;
    mihomo)
      gzip -dc "$archive" >"$BIN_DIR/mihomo"
      chmod 0755 "$BIN_DIR/mihomo"
      binary="$BIN_DIR/mihomo"
      version_output="$("$binary" -v 2>&1)"
      printf '%s\n' "$version_output" | grep -F "$version" >/dev/null
      ;;
    sing-box)
      release_dir="$WORK_DIR/sing-box-release"
      mkdir -p "$release_dir"
      tar -xzf "$archive" -C "$release_dir" --strip-components=1
      install -m 0755 "$release_dir/sing-box" "$BIN_DIR/sing-box"
      binary="$BIN_DIR/sing-box"
      version_output="$("$binary" version 2>&1)"
      printf '%s\n' "$version_output" | grep -F "$version" >/dev/null
      ;;
    *)
      echo "ERROR unknown-client=$client"
      return 2
      ;;
  esac
  echo "OK client=$client version=$version sha256=verified"
}

api_get() {
  curl -fsS --max-time 30 --retry 3 --retry-delay 2 --retry-all-errors \
    "$CONTROL_API$1" \
    -H "authorization: Bearer $ADMIN_TOKEN"
}

echo "STEP login"
LOGIN_RESPONSE="$(curl -fsS --max-time 30 --retry 3 --retry-delay 2 \
  --retry-all-errors -X POST \
  "$CONTROL_API/api/admin/login" \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg password "$ADMIN_PASSWORD" '{password:$password}')")"
ADMIN_TOKEN="$(printf '%s' "$LOGIN_RESPONSE" | jq -er '.token')"
echo "::add-mask::$ADMIN_TOKEN"
echo "OK login"

echo "STEP choose-canary-node"
NODES_RESPONSE="$(api_get "/api/nodes")"
if [ -n "${COMPAT_NODE_ID:-}" ]; then
  NODE="$(printf '%s' "$NODES_RESPONSE" | jq -ec \
    --arg id "$COMPAT_NODE_ID" \
    '.nodes[] | select(.id == $id and .enabled == 1 and .health == "healthy")' |
    head -n 1)"
else
  NODE="$(printf '%s' "$NODES_RESPONSE" | jq -ec \
    '[.nodes[] | select(.enabled == 1 and .health == "healthy")] | sort_by(.id) | .[0]')"
fi
NODE_ID="$(printf '%s' "$NODE" | jq -er '.id')"
NODE_ACCOUNT_ALIAS="$(printf '%s' "$NODE" | jq -er '.account_alias')"
NODE_HOST="$(printf '%s' "$NODE" | jq -er '.hostname')"
NODE_PATH="$(printf '%s' "$NODE" | jq -er '.transport_path')"
if ! printf '%s' "$NODE_PATH" | grep -Eq '^/[^?#[:space:]]*$'; then
  echo "ERROR canary-node-invalid-transport-path"
  exit 3
fi
echo "OK canary-node id=$NODE_ID host=$NODE_HOST path=$NODE_PATH"

echo "STEP compliance-gate"
node infra/scripts/compliance-gate.mjs \
  --mode data-plane-test \
  --node-id "$NODE_ID" \
  --account-alias "$NODE_ACCOUNT_ALIAS"
echo "OK compliance-gate"

download_client xray
download_client mihomo
download_client sing-box

echo "STEP create-isolated-user"
RUN_TAG="${GITHUB_RUN_ID:-manual-$(date +%s)}-${GITHUB_RUN_ATTEMPT:-1}"
CANARY_USERNAME="__clientcompat__-$RUN_TAG"
CREATE_RESPONSE="$(curl -fsS --max-time 30 -X POST \
  "$CONTROL_API/api/users" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  --data "$(jq -nc \
    --arg username "$CANARY_USERNAME" \
    --arg nodeId "$NODE_ID" \
    '{
      username:$username,
      nodeGroup:[$nodeId],
      unlock:false,
      durationDays:1,
      deviceLimit:4,
      ipLimit24h:10,
      trafficLimitBytes:0
    }')")"
USER_ID="$(printf '%s' "$CREATE_RESPONSE" | jq -er '.user.id')"
USER_IDENTITY_UUID="$(printf '%s' "$CREATE_RESPONSE" | jq -er '.user.uuid')"
USER_UUID="$(printf '%s' "$CREATE_RESPONSE" | jq -er '.credential.uuid')"
SUB_TOKEN="$(printf '%s' "$CREATE_RESPONSE" | jq -er '.user.sub_token')"
SUB_URL="$(printf '%s' "$CREATE_RESPONSE" | jq -er '.subUrl')"
echo "::add-mask::$USER_ID"
echo "::add-mask::$USER_IDENTITY_UUID"
echo "::add-mask::$USER_UUID"
echo "::add-mask::$SUB_TOKEN"
echo "::add-mask::$SUB_URL"
echo "OK isolated-user-created"

# User mutation invalidation must reach the chosen edge before a real client starts.
sleep 8

echo "STEP fetch-subscriptions"
curl -fsS --max-time 30 --retry 3 --retry-delay 2 --retry-all-errors \
  "$SUB_URL?format=base64" -o "$SUB_DIR/base64.txt"
curl -fsS --max-time 30 --retry 3 --retry-delay 2 --retry-all-errors \
  "$SUB_URL?format=xray" -o "$SUB_DIR/xray.json"
curl -fsS --max-time 30 --retry 3 --retry-delay 2 --retry-all-errors \
  "$SUB_URL?format=mihomo" -o "$SUB_DIR/mihomo.yaml"
curl -fsS --max-time 30 --retry 3 --retry-delay 2 --retry-all-errors \
  "$SUB_URL?format=singbox" -o "$SUB_DIR/sing-box.json"
echo "OK subscription-formats=base64,xray,mihomo,sing-box"

node infra/scripts/prepare-client-configs.mjs \
  --base64 "$SUB_DIR/base64.txt" \
  --xray "$SUB_DIR/xray.json" \
  --mihomo "$SUB_DIR/mihomo.yaml" \
  --singbox "$SUB_DIR/sing-box.json" \
  --output-dir "$CONFIG_DIR"

BEFORE_USER="$(api_get "/api/users" | jq -ec \
  --arg id "$USER_ID" '.users[] | select(.id == $id)')"
BEFORE_CONNECTIONS="$(printf '%s' "$BEFORE_USER" | jq -er '.connections')"
BEFORE_UP="$(printf '%s' "$BEFORE_USER" | jq -er '.bytes_up')"
BEFORE_DOWN="$(printf '%s' "$BEFORE_USER" | jq -er '.bytes_down')"

echo "STEP validate-client-configs"
XRAY_LOCATION_ASSET="$BIN_DIR" \
  "$BIN_DIR/xray" run -test -config "$CONFIG_DIR/xray.json" >/dev/null
mkdir -p "$WORK_DIR/mihomo-home"
"$BIN_DIR/mihomo" -t -d "$WORK_DIR/mihomo-home" \
  -f "$CONFIG_DIR/mihomo.yaml" >/dev/null
"$BIN_DIR/sing-box" check -c "$CONFIG_DIR/sing-box.json" >/dev/null
echo "OK client-configs=xray,mihomo,sing-box"

wait_for_port() {
  local pid="$1" port="$2" client="$3" attempt
  for attempt in $(seq 1 40); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      echo "ERROR client=$client exited-before-listen"
      sed -e "s/$USER_IDENTITY_UUID/[masked-user-uuid]/g" \
        -e "s/$USER_UUID/[masked-credential-uuid]/g" "$LOG_DIR/$client.log" |
        tail -n 20
      return 1
    fi
    if timeout 1 bash -c "echo > /dev/tcp/127.0.0.1/$port" \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "ERROR client=$client listen-timeout port=$port"
  return 1
}

run_client() {
  local client="$1" port="$2" pid
  echo "STEP real-client client=$client"
  case "$client" in
    xray)
      XRAY_LOCATION_ASSET="$BIN_DIR" \
        "$BIN_DIR/xray" run -config "$CONFIG_DIR/xray.json" \
        >"$LOG_DIR/xray.log" 2>&1 &
      ;;
    mihomo)
      "$BIN_DIR/mihomo" -d "$WORK_DIR/mihomo-home" \
        -f "$CONFIG_DIR/mihomo.yaml" \
        >"$LOG_DIR/mihomo.log" 2>&1 &
      ;;
    sing-box)
      "$BIN_DIR/sing-box" run -c "$CONFIG_DIR/sing-box.json" \
        >"$LOG_DIR/sing-box.log" 2>&1 &
      ;;
  esac
  pid=$!
  CLIENT_PIDS+=("$pid")
  wait_for_port "$pid" "$port" "$client"
  curl -fsS --max-time 30 --connect-timeout 15 \
    --socks5-hostname "127.0.0.1:$port" \
    "$TARGET_URL" -o /dev/null
  sleep 1
  kill "$pid" >/dev/null 2>&1 || true
  wait "$pid" >/dev/null 2>&1 || true
  sleep 3
  echo "OK real-client=$client tls=strict sni=$NODE_HOST websocket=$NODE_PATH"
}

run_client xray 18081
run_client mihomo 18082
run_client sing-box 18083

echo "STEP verify-usage"
USAGE_OK=false
CURRENT_CONNECTIONS="$BEFORE_CONNECTIONS"
CURRENT_UP="$BEFORE_UP"
CURRENT_DOWN="$BEFORE_DOWN"
for _attempt in $(seq 1 18); do
  CURRENT_USER="$(api_get "/api/users" | jq -ec \
    --arg id "$USER_ID" '.users[] | select(.id == $id)')"
  CURRENT_CONNECTIONS="$(printf '%s' "$CURRENT_USER" | jq -er '.connections')"
  CURRENT_UP="$(printf '%s' "$CURRENT_USER" | jq -er '.bytes_up')"
  CURRENT_DOWN="$(printf '%s' "$CURRENT_USER" | jq -er '.bytes_down')"
  if [ "$((CURRENT_CONNECTIONS - BEFORE_CONNECTIONS))" -ge 3 ] &&
    [ "$((CURRENT_UP - BEFORE_UP))" -gt 0 ] &&
    [ "$((CURRENT_DOWN - BEFORE_DOWN))" -gt 0 ]; then
    USAGE_OK=true
    break
  fi
  sleep 5
done

CONNECTION_DELTA=$((CURRENT_CONNECTIONS - BEFORE_CONNECTIONS))
UP_DELTA=$((CURRENT_UP - BEFORE_UP))
DOWN_DELTA=$((CURRENT_DOWN - BEFORE_DOWN))
if [ "$USAGE_OK" != true ]; then
  echo "ERROR usage-not-observed connections=$CONNECTION_DELTA bytesUp=$UP_DELTA bytesDown=$DOWN_DELTA"
  exit 4
fi
echo "OK usage connections=$CONNECTION_DELTA bytesUp=$UP_DELTA bytesDown=$DOWN_DELTA"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Opus8 client compatibility"
    echo
    echo "- Canary node: \`$NODE_ID\`"
    echo "- Transport: strict TLS + SNI + VLESS-over-WebSocket"
    echo "- Xray: OK"
    echo "- Mihomo: OK"
    echo "- sing-box: OK"
    echo "- Usage delta: $CONNECTION_DELTA connections, $UP_DELTA bytes up, $DOWN_DELTA bytes down"
    echo "- Canary user: deleted by cleanup"
  } >>"$GITHUB_STEP_SUMMARY"
fi

echo "DONE clients=3 node=$NODE_ID connections=$CONNECTION_DELTA"
