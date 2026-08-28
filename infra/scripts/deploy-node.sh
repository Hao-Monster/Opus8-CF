#!/usr/bin/env bash
# 部署单个边缘节点：构建补丁版 worker、探测落地机端口、部署、设密钥、注册、验证。
# 需要环境变量：
#   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
#   CONTROL_ROOT_DOMAIN / CONTROL_AUTOMATION_SECRET / ROOT_DOMAIN / NODE_ENROLLMENT_TOKEN
#   NODE_ID / NODE_ACCOUNT_ALIAS / NODE_REGION
#   NODE_HOSTNAME（可选；缺省为 <NODE_ID><NODE_DEPLOY_SUFFIX>.<ROOT_DOMAIN>）
#   NODE_DEPLOY_SUFFIX  (可选，例如 -v2，用于无损替换异常 Worker 槽位)
#   NODE_DEPLOY_OPERATION=maintenance|provision（缺省 maintenance）
#   NODE_TRANSPORT_PATH (可选；缺省时按节点稳定派生)
#   TRANSPORT_MIGRATION_MODE=canary|strict（缺省 canary，上一条路径保留 72 小时）
#   WORKER_PLACEMENT_HOST（可选；Targeted Placement 的 host:port）
#   SERVICES_IP / SERVICES_PORT / SOCKS_USER / SOCKS_PASSWORD
#     (SOCKS5；端口可缺省自动探测，显式端口不可用时失败关闭)
#   VPS_HOST / VPS_SSH_USER / VPS_SSH_PASSWORD / VPS_SSH_PORT
#     (可选，仅用于部署后的第二视角冒烟)
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"
cd packages/edge-node

: "${NODE_ID:?}"; : "${NODE_ACCOUNT_ALIAS:?}"; : "${NODE_ENROLLMENT_TOKEN:?}"
: "${CLOUDFLARE_ACCOUNT_ID:?}"
: "${CONTROL_AUTOMATION_SECRET:?CONTROL_AUTOMATION_SECRET is required for credential retirement}"
: "${ROOT_DOMAIN:?ROOT_DOMAIN is required for production custom domains}"
: "${CONTROL_ROOT_DOMAIN:?CONTROL_ROOT_DOMAIN is required}"
NODE_REGION="${NODE_REGION:-}"
NODE_DEPLOY_SUFFIX="${NODE_DEPLOY_SUFFIX:-}"
if [ -n "$NODE_DEPLOY_SUFFIX" ] \
  && ! printf '%s' "$NODE_DEPLOY_SUFFIX" | grep -qE '^-[a-z0-9]+$'; then
  echo "ERROR invalid-node-deploy-suffix"
  exit 9
fi
ROOT_DOMAIN="${ROOT_DOMAIN#https://}"; ROOT_DOMAIN="${ROOT_DOMAIN#http://}"; ROOT_DOMAIN="${ROOT_DOMAIN%%/*}"
CONTROL_ROOT_DOMAIN="${CONTROL_ROOT_DOMAIN#https://}"; CONTROL_ROOT_DOMAIN="${CONTROL_ROOT_DOMAIN#http://}"; CONTROL_ROOT_DOMAIN="${CONTROL_ROOT_DOMAIN%%/*}"
CONTROL_PLANE_URL="https://api.${CONTROL_ROOT_DOMAIN}"
CUSTOM_HOST="${NODE_HOSTNAME:-${NODE_ID}${NODE_DEPLOY_SUFFIX}.${ROOT_DOMAIN}}"
CUSTOM_HOST="${CUSTOM_HOST%.}"
if [ "$CUSTOM_HOST" != "$ROOT_DOMAIN" ] \
  && [[ "$CUSTOM_HOST" != *."$ROOT_DOMAIN" ]]; then
  echo "ERROR node-hostname-outside-root-domain"
  exit 9
fi
CUSTOM_URL="https://${CUSTOM_HOST}"
WORKER_NAME="opus8cf-node-${NODE_ID}${NODE_DEPLOY_SUFFIX}"
OPUS8_BUILD_ID="${GITHUB_SHA:-manual}-${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-0}"
NODE_DEPLOY_OPERATION="${NODE_DEPLOY_OPERATION:-maintenance}"
WORKER_PLACEMENT_HOST="${WORKER_PLACEMENT_HOST:-}"
if ! WORKER_PLACEMENT_HOST=$(WORKER_PLACEMENT_HOST="$WORKER_PLACEMENT_HOST" \
  node "$REPO_ROOT/infra/scripts/worker-placement-host.mjs"); then
  exit 9
fi
WORKER_PLACEMENT_CONFIG=""
if [ -n "$WORKER_PLACEMENT_HOST" ]; then
  WORKER_PLACEMENT_CONFIG=$(printf '[placement]\nhost = "%s"\n' "$WORKER_PLACEMENT_HOST")
  echo "INFO targeted-placement host=$WORKER_PLACEMENT_HOST"
fi
SERVICES_PORT="${SERVICES_PORT:-}"
if [ -n "$SERVICES_PORT" ] && {
  ! printf '%s' "$SERVICES_PORT" | grep -qE '^[1-9][0-9]{0,4}$' \
    || [ "$SERVICES_PORT" -gt 65535 ];
}; then
  echo "ERROR invalid-services-port"
  exit 9
fi
case "$NODE_DEPLOY_OPERATION" in
  maintenance) COMPLIANCE_GATE_MODE=node-maintenance ;;
  provision) COMPLIANCE_GATE_MODE=node-provision ;;
  *) echo "ERROR invalid-node-deploy-operation"; exit 9 ;;
esac
echo "STEP compliance-gate"
node "$REPO_ROOT/infra/scripts/compliance-gate.mjs" \
  --mode "$COMPLIANCE_GATE_MODE" \
  --node-id "$NODE_ID" \
  --account-alias "$NODE_ACCOUNT_ALIAS" \
  --worker-name "$WORKER_NAME"
echo "OK compliance-gate"
TRANSPORT_MIGRATION_MODE="${TRANSPORT_MIGRATION_MODE:-$(
  tr -d '[:space:]' <"$REPO_ROOT/infra/transport-mode.txt"
)}"
TRANSPORT_LEGACY_GRACE_HOURS="${TRANSPORT_LEGACY_GRACE_HOURS:-72}"
case "$TRANSPORT_MIGRATION_MODE" in
  canary|strict) ;;
  *) echo "ERROR invalid-transport-migration-mode"; exit 9 ;;
esac
if ! printf '%s' "$TRANSPORT_LEGACY_GRACE_HOURS" | grep -qE '^[0-9]+$' \
  || [ "$TRANSPORT_LEGACY_GRACE_HOURS" -lt 1 ] \
  || [ "$TRANSPORT_LEGACY_GRACE_HOURS" -gt 720 ]; then
  echo "ERROR invalid-transport-legacy-grace-hours"
  exit 9
fi
normalize_transport_path() {
  TRANSPORT_CANDIDATE="$1" node -e '
    const path=String(process.env.TRANSPORT_CANDIDATE||"").trim();
    const reserved=["/__opus8","/admin","/login","/sub","/version","/locations","/robots.txt","/favicon.ico"];
    const lower=path.toLowerCase();
    const valid=path.length>0&&path.length<=128&&
      /^\/[A-Za-z0-9._~/-]*$/.test(path)&&!path.includes("//")&&
      !path.split("/").some(x=>x==="."||x==="..")&&
      !reserved.some(x=>lower===x||lower.startsWith(x+"/"));
    if(!valid) process.exit(1);
    process.stdout.write(path);
  '
}

echo "STEP exchange-one-time-enrollment"
echo "::add-mask::$NODE_ENROLLMENT_TOKEN"
ENROLL_BODY=$(NODE_ENROLLMENT_TOKEN="$NODE_ENROLLMENT_TOKEN" \
  NODE_ID="$NODE_ID" CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" node -e '
    process.stdout.write(JSON.stringify({
      token:process.env.NODE_ENROLLMENT_TOKEN,
      nodeId:process.env.NODE_ID,
      accountId:process.env.CLOUDFLARE_ACCOUNT_ID
    }))
  ')
if ! ENROLL_RESPONSE=$(curl -fsS --max-time 20 -X POST \
  "$CONTROL_PLANE_URL/api/node-enrollments/exchange" \
  -H 'content-type: application/json' --data "$ENROLL_BODY"); then
  echo "ERROR enrollment-exchange-failed"
  exit 9
fi
if ! ENROLL_VALUES=$(printf '%s' "$ENROLL_RESPONSE" \
  | NODE_ID="$NODE_ID" NODE_ACCOUNT_ALIAS="$NODE_ACCOUNT_ALIAS" \
    CUSTOM_HOST="$CUSTOM_HOST" CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" \
    NODE_DEPLOY_OPERATION="$NODE_DEPLOY_OPERATION" node -e '
      let s="";
      process.stdin.on("data",d=>s+=d).on("end",()=>{
        const value=JSON.parse(s);
        const e=value.enrollment||{};
        const normalize=x=>String(x||"").trim().toLowerCase().replace(/\.$/,"");
        const expectedKinds=process.env.NODE_DEPLOY_OPERATION==="provision"
          ?["provision"]:["migrate","rotate"];
        if(!/^[a-f0-9]{64}$/i.test(String(value.nodeSecret||""))||
          e.nodeId!==process.env.NODE_ID||
          e.accountAlias!==process.env.NODE_ACCOUNT_ALIAS||
          e.accountId!==String(process.env.CLOUDFLARE_ACCOUNT_ID).toLowerCase()||
          normalize(e.hostname)!==normalize(process.env.CUSTOM_HOST)||
          !expectedKinds.includes(e.kind)){
          process.exit(2);
        }
        process.stdout.write([
          value.nodeSecret,
          String(e.transportPath||""),
          String(e.kind||"")
        ].join("\n"));
      });
    '); then
  echo "ERROR enrollment-identity-mismatch"
  exit 9
fi
NODE_HMAC_SECRET=$(printf '%s\n' "$ENROLL_VALUES" | sed -n '1p')
PREVIOUS_TRANSPORT_PATH=$(printf '%s\n' "$ENROLL_VALUES" | sed -n '2p')
ENROLLMENT_KIND=$(printf '%s\n' "$ENROLL_VALUES" | sed -n '3p')
echo "::add-mask::$NODE_HMAC_SECRET"
unset NODE_ENROLLMENT_TOKEN ENROLL_BODY ENROLL_RESPONSE ENROLL_VALUES
export NODE_HMAC_SECRET
if ! PREVIOUS_TRANSPORT_PATH=$(normalize_transport_path "$PREVIOUS_TRANSPORT_PATH"); then
  echo "ERROR invalid-enrollment-transport-path"
  exit 9
fi
echo "OK enrollment-exchanged kind=$ENROLLMENT_KIND"

if [ -n "${NODE_TRANSPORT_PATH:-}" ] \
  && [ "$NODE_TRANSPORT_PATH" != "$PREVIOUS_TRANSPORT_PATH" ]; then
  echo "ERROR transport-path-must-match-enrollment"
  exit 9
fi
TRANSPORT_CANDIDATE="$PREVIOUS_TRANSPORT_PATH"
if ! TRANSPORT_PATH=$(normalize_transport_path "$TRANSPORT_CANDIDATE"); then
  echo "ERROR invalid-node-transport-path"
  exit 9
fi
if [ "$TRANSPORT_MIGRATION_MODE" = "canary" ]; then
  if [ "$PREVIOUS_TRANSPORT_PATH" != "$TRANSPORT_PATH" ]; then
    TRANSPORT_LEGACY_PATH="$PREVIOUS_TRANSPORT_PATH"
  elif [ "$TRANSPORT_PATH" != "/" ]; then
    TRANSPORT_LEGACY_PATH="/"
  else
    TRANSPORT_LEGACY_PATH=""
  fi
  TRANSPORT_LEGACY_UNTIL=$(($(date +%s%3N) + TRANSPORT_LEGACY_GRACE_HOURS * 60 * 60 * 1000))
else
  TRANSPORT_LEGACY_PATH=""
  TRANSPORT_LEGACY_UNTIL=0
fi
TRANSPORT_URL_PATH="${TRANSPORT_PATH}?ed=2560"
echo "INFO transport path=$TRANSPORT_PATH previous=$PREVIOUS_TRANSPORT_PATH mode=$TRANSPORT_MIGRATION_MODE legacy=$TRANSPORT_LEGACY_PATH legacyUntil=$TRANSPORT_LEGACY_UNTIL"

echo "STEP build"
if ! node build/build.mjs >/tmp/nb.log 2>&1; then echo "ERROR build"; tail -n 8 /tmp/nb.log; exit 10; fi
echo "OK built ($(cat /tmp/nb.log))"
if ! node build/policy-test.mjs >/tmp/policy.log 2>&1; then echo "ERROR policy-test"; tail -n 8 /tmp/policy.log; exit 10; fi
echo "OK policy-test"

echo "STEP probe-landing"
PORT=""; LAND=""; PTYPE=""
if [ -n "${SERVICES_IP:-}" ]; then
  probe_socks5_port() {
    local p="$1" out outn
    outn=$(curl -s -x "socks5h://${SERVICES_IP}:$p" \
      --connect-timeout 6 --max-time 12 https://api.ipify.org 2>/dev/null || true)
    if echo "$outn" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
      if [ -n "${SOCKS_USER:-}" ] || [ -n "${SOCKS_PASSWORD:-}" ]; then
        echo "WARN landing-port=$p rejected=socks5-noauth exit=$outn"
        return 1
      fi
      PORT=$p; PTYPE=socks5-noauth
      echo "OK landing-port=$p type=socks5(no-auth) exit=$outn"
      return 0
    fi
    out=$(curl -s -x "socks5h://${SERVICES_IP}:$p" \
      --proxy-user "${SOCKS_USER:-}:${SOCKS_PASSWORD:-}" \
      --connect-timeout 6 --max-time 12 https://api.ipify.org 2>/dev/null || true)
    if echo "$out" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
      PORT=$p; PTYPE=socks5-auth
      echo "OK landing-port=$p type=socks5(auth) exit=$out"
      return 0
    fi
    return 1
  }

  # 显式端口是部署契约；不可用时停止，避免静默切到另一条出口。
  if [ -n "$SERVICES_PORT" ]; then
    if ! probe_socks5_port "$SERVICES_PORT"; then
      echo "ERROR configured-landing-unavailable port=$SERVICES_PORT"
      exit 11
    fi
  fi
  # 未配置端口时先试已知/常见端口，命中即跳过全端口扫描。
  for p in 40010 40008 1080 1081 7890 8388 1088; do
    [ -n "$PORT" ] && break
    [ -z "$p" ] && continue
    probe_socks5_port "$p" || true
  done
  OPEN=""
  if [ -z "$PORT" ]; then
    sudo apt-get update >/dev/null 2>&1 || true
    sudo apt-get install -y nmap >/dev/null 2>&1 || true
    if command -v nmap >/dev/null 2>&1; then
      OPEN=$(nmap -Pn -T4 --min-rate 3000 -p- "${SERVICES_IP}" 2>/dev/null | grep -oE '^[0-9]+/tcp[[:space:]]+open' | grep -oE '^[0-9]+' | tr '\n' ' ')
    fi
    echo "INFO tcp-open-ports:${OPEN:- 无}"
  fi
  n=0
  for p in $OPEN; do
    [ -n "$PORT" ] && break
    n=$((n+1)); [ "$n" -gt 20 ] && break
    probe_socks5_port "$p" && break
    outh=$(curl -s -x "http://${SERVICES_IP}:$p" --proxy-user "${SOCKS_USER:-}:${SOCKS_PASSWORD:-}" --connect-timeout 6 --max-time 12 https://api.ipify.org 2>/dev/null || true)
    if echo "$outh" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then echo "INFO port=$p 是 HTTP 代理(非 SOCKS5) exit=$outh"; fi
  done
  if [ -n "$PORT" ]; then
    if [ "$PTYPE" = "socks5-auth" ] && [ -n "${SOCKS_USER:-}" ]; then LAND="${SOCKS_USER}:${SOCKS_PASSWORD}@${SERVICES_IP}:${PORT}"; else LAND="${SERVICES_IP}:${PORT}"; fi
  else
    echo "INFO landing-no-socks5 (纯 CF 出口，无解锁)"
  fi
else
  echo "INFO no-SERVICES_IP (纯 CF 出口)"
fi

echo "STEP activate-staged-credential"
RCODE=000
for n in $(seq 1 18); do
  TS=$(date +%s)000
  BODY=$(H="$CUSTOM_HOST" HASLAND="$LAND" TP="$TRANSPORT_PATH" node -e "process.stdout.write(JSON.stringify({nodeId:process.env.NODE_ID,accountAlias:process.env.NODE_ACCOUNT_ALIAS,hostname:process.env.H,region:process.env.NODE_REGION||null,transportPath:process.env.TP,capabilities:['vless-ws','transport-path-v1','anti-share-v1','usage-v1','hmac-v2'].concat(process.env.HASLAND?['unlock']:[])}))")
  SIG=$(printf 'opus8-hmac-v2\n%s\n%s\n%s\n%s\n%s' \
    "$TS" "$NODE_ID" "POST" "/api/nodes/register" "$BODY" \
    | openssl dgst -sha256 -hmac "$NODE_HMAC_SECRET" -r | cut -d' ' -f1)
  RCODE=$(curl -s -o /tmp/reg.json -w '%{http_code}' --max-time 20 -X POST "$CONTROL_PLANE_URL/api/nodes/register" \
    -H "x-opus8-ts: $TS" -H "x-opus8-node: $NODE_ID" -H "x-opus8-sign-v2: $SIG" -H 'content-type: application/json' -d "$BODY" || true)
  [ "$RCODE" = "200" ] && break
  sleep 10
done
REGISTERED_PATH=$(TP="$TRANSPORT_PATH" node -e '
  const fs=require("node:fs");
  try {
    const value=JSON.parse(fs.readFileSync("/tmp/reg.json","utf8"));
    process.stdout.write(value.transportPath===process.env.TP?value.transportPath:"");
  } catch {}
')
if [ "$RCODE" = "200" ] && [ "$REGISTERED_PATH" = "$TRANSPORT_PATH" ]; then
  echo "OK staged-credential-active host=$CUSTOM_HOST transport=$TRANSPORT_PATH"
else
  echo "ERROR credential-activation http=$RCODE transport-path-mismatch"
  exit 13
fi

echo "STEP kv"
wrangler kv namespace create OPUS8_NODE_KV >/dev/null 2>&1 || true
KVID=$(wrangler kv namespace list 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const x=a.find(r=>r.title&&r.title.includes("OPUS8_NODE_KV"));process.stdout.write(x?x.id:"")}catch(e){process.stdout.write("")}})')
if [ -z "$KVID" ]; then echo "ERROR kv-id (token 缺 KV 权限?)"; exit 11; fi
echo "OK kv=${KVID:0:8}…"

# AI 解锁白名单（*<domain> 形式，仅命中这些域名走落地）
GO2=$(sed 's/^/*/' "${REPO_ROOT}/infra/ai-unlock.txt" 2>/dev/null | paste -sd, -)

NODE_UUID_HEX=$(printf 'node-fallback:%s' "$NODE_ID" \
  | openssl dgst -sha256 -hmac "$NODE_HMAC_SECRET" -r \
  | cut -d' ' -f1)
NODE_UUID="${NODE_UUID_HEX:0:8}-${NODE_UUID_HEX:8:4}-4${NODE_UUID_HEX:13:3}-8${NODE_UUID_HEX:17:3}-${NODE_UUID_HEX:20:12}"

cat > wrangler.toml <<EOF
name = "${WORKER_NAME}"
main = "dist/index.js"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true

${WORKER_PLACEMENT_CONFIG}
[vars]
CONTROL_PLANE_URL = "${CONTROL_PLANE_URL}"
NODE_ID = "${NODE_ID}"
NODE_ACCOUNT_ALIAS = "${NODE_ACCOUNT_ALIAS}"
NODE_REGION = "${NODE_REGION}"
OPUS8_BUILD_ID = "${OPUS8_BUILD_ID}"
OPUS8_TRANSPORT_PATH = "${TRANSPORT_PATH}"
OPUS8_TRANSPORT_LEGACY_PATH = "${TRANSPORT_LEGACY_PATH}"
OPUS8_TRANSPORT_LEGACY_UNTIL = "${TRANSPORT_LEGACY_UNTIL}"
GO2SOCKS5 = "${GO2}"

[[kv_namespaces]]
binding = "KV"
id = "${KVID}"

[[routes]]
pattern = "${CUSTOM_HOST}"
custom_domain = true
EOF

echo "STEP deploy"
if ! wrangler deploy >/tmp/nd.log 2>&1; then echo "ERROR deploy"; tail -n 8 /tmp/nd.log | sed 's/[A-Za-z0-9_-]\{24,\}/<redacted>/g'; exit 12; fi
WORKERS_URL=$(grep -oE 'https://[a-z0-9._-]+workers\.dev' /tmp/nd.log | head -n1 || true)
URL="$CUSTOM_URL"
HOST="$CUSTOM_HOST"
echo "OK deployed workers=${WORKERS_URL:-unreported} custom=$URL"

echo "STEP secrets"
NODE_HMAC_SECRET="$NODE_HMAC_SECRET" NODE_UUID="$NODE_UUID" LAND="$LAND" node -e '
  const secrets = {
    NODE_HMAC_SECRET: process.env.NODE_HMAC_SECRET,
    UUID: process.env.NODE_UUID,
  };
  if (process.env.LAND) secrets.SOCKS5 = process.env.LAND;
  process.stdout.write(JSON.stringify(secrets));
' | wrangler secret bulk >/dev/null 2>&1
if [ -n "$LAND" ]; then
  echo "OK secrets-bulk hmac+uuid+socks5"
else
  echo "OK secrets-bulk hmac+uuid"
fi

echo "STEP wait-deployed-version"
VERSION_READY=0
for n in $(seq 1 60); do
  CUSTOM_BUILD=$(curl -fsS --max-time 12 "${CUSTOM_URL}/__opus8/build" 2>/dev/null \
    | EXPECTED_NODE="$NODE_ID" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.nodeId===process.env.EXPECTED_NODE?String(j.buildId||""):"")}catch(e){}})' || true)
  WORKERS_BUILD=""
  if [ -n "$WORKERS_URL" ]; then
    WORKERS_BUILD=$(curl -fsS --max-time 12 "${WORKERS_URL}/__opus8/build" 2>/dev/null \
      | EXPECTED_NODE="$NODE_ID" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.nodeId===process.env.EXPECTED_NODE?String(j.buildId||""):"")}catch(e){}})' || true)
  fi
  if [ "$CUSTOM_BUILD" = "$OPUS8_BUILD_ID" ] \
    && { [ -z "$WORKERS_URL" ] || [ "$WORKERS_BUILD" = "$OPUS8_BUILD_ID" ]; }; then
    VERSION_READY=1
    break
  fi
  sleep 5
done
if [ "$VERSION_READY" != "1" ]; then
  echo "ERROR deployed-version-not-active"
  exit 12
fi
echo "OK deployed-version-active custom=1 workers=1"

echo "STEP wait-custom-domain"
DOMAIN_OK=0
NC=000
for n in $(seq 1 24); do
  NC=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$URL/" || true)
  if [ -n "$NC" ] && [ "$NC" != "000" ]; then DOMAIN_OK=1; break; fi
  sleep 10
done
if [ "$DOMAIN_OK" != "1" ]; then echo "ERROR node-custom-domain-unreachable"; exit 14; fi
echo "OK custom-domain-ready"

echo "STEP edge-gateway-regression"
gateway_build_id() {
  sed -n 's/^x-opus8-build-id:[[:space:]]*//Ip' "$1" \
    | tr -d '\r' | tail -n1
}
ROOT_CODE=000
ROOT_BUILD=""
for n in $(seq 1 12); do
  ROOT_CODE=$(curl -sS -o /tmp/edge-root.body -D /tmp/edge-root.headers \
    -w '%{http_code}' --max-time 15 \
    -H 'cache-control: no-cache' -H 'pragma: no-cache' \
    "$URL/?__opus8_build=${OPUS8_BUILD_ID}-${n}" || true)
  ROOT_BUILD=$(gateway_build_id /tmp/edge-root.headers)
  if [ "$ROOT_CODE" = "200" ] \
    && [ "$ROOT_BUILD" = "$OPUS8_BUILD_ID" ] \
    && grep -qi '^x-content-type-options:[[:space:]]*nosniff' /tmp/edge-root.headers \
    && grep -qi '^content-security-policy:' /tmp/edge-root.headers \
    && grep -q 'Service available' /tmp/edge-root.body; then
    break
  fi
  sleep 3
done
if [ "$ROOT_CODE" != "200" ] || [ "$ROOT_BUILD" != "$OPUS8_BUILD_ID" ] \
  || ! grep -qi '^x-content-type-options:[[:space:]]*nosniff' /tmp/edge-root.headers \
  || ! grep -qi '^content-security-policy:' /tmp/edge-root.headers \
  || ! grep -q 'Service available' /tmp/edge-root.body; then
  echo "ERROR edge-root-gateway http=$ROOT_CODE"
  exit 14
fi
for route in login admin admin/config.json admin/sub-links sub version locations; do
  for method in GET POST; do
    GATEWAY_CODE=000
    GATEWAY_BUILD=""
    for n in $(seq 1 12); do
      GATEWAY_CODE=$(curl -sS -X "$method" -o /tmp/edge-gateway.body \
        -D /tmp/edge-gateway.headers -w '%{http_code}' --max-time 15 \
        -H 'cache-control: no-cache' -H 'pragma: no-cache' \
        "$URL/$route?__opus8_build=${OPUS8_BUILD_ID}-${n}" || true)
      GATEWAY_BUILD=$(gateway_build_id /tmp/edge-gateway.headers)
      if [ "$GATEWAY_CODE" = "404" ] \
        && [ "$GATEWAY_BUILD" = "$OPUS8_BUILD_ID" ] \
        && ! grep -qi '^set-cookie:' /tmp/edge-gateway.headers; then
        break
      fi
      sleep 3
    done
    if [ "$GATEWAY_CODE" != "404" ] \
      || [ "$GATEWAY_BUILD" != "$OPUS8_BUILD_ID" ] \
      || grep -qi '^set-cookie:' /tmp/edge-gateway.headers; then
      echo "ERROR legacy-edge-route-open method=$method route=/$route http=$GATEWAY_CODE active-build=$([ "$GATEWAY_BUILD" = "$OPUS8_BUILD_ID" ] && echo yes || echo no)"
      exit 14
    fi
  done
done
UPGRADE_CODE=000
UPGRADE_BUILD=""
for n in $(seq 1 12); do
  UPGRADE_CODE=$(curl -sS --http1.1 -o /tmp/edge-upgrade.body \
    -D /tmp/edge-upgrade.headers -w '%{http_code}' --max-time 15 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    -H 'cache-control: no-cache' -H 'pragma: no-cache' \
    "$URL/admin?__opus8_build=${OPUS8_BUILD_ID}-${n}" || true)
  UPGRADE_BUILD=$(gateway_build_id /tmp/edge-upgrade.headers)
  if [ "$UPGRADE_CODE" = "404" ] \
    && [ "$UPGRADE_BUILD" = "$OPUS8_BUILD_ID" ]; then
    break
  fi
  sleep 3
done
if [ "$UPGRADE_CODE" != "404" ] || [ "$UPGRADE_BUILD" != "$OPUS8_BUILD_ID" ]; then
  echo "ERROR wrong-path-websocket-open http=$UPGRADE_CODE"
  exit 14
fi
echo "OK edge-gateway-legacy-routes-closed"

echo "STEP verify"
echo "OK node-tls-http=$NC"
TS2=$(date +%s)000
UUID_PATH="/api/nodes/$NODE_ID/uuids"
SIG2=$(printf 'opus8-hmac-v2\n%s\n%s\n%s\n%s\n%s' \
  "$TS2" "$NODE_ID" "GET" "$UUID_PATH" "" \
  | openssl dgst -sha256 -hmac "$NODE_HMAC_SECRET" -r | cut -d' ' -f1)
if ! UDATA=$(curl -fsS --max-time 20 "$CONTROL_PLANE_URL/api/nodes/$NODE_ID/uuids" \
  -H "x-opus8-ts: $TS2" -H "x-opus8-node: $NODE_ID" -H "x-opus8-sign-v2: $SIG2"); then
  echo "ERROR uuids-endpoint"; exit 15
fi
UC=$(printf '%s' "$UDATA" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String((j.uuids||[]).length))}catch(e){process.stdout.write("err")}})')
echo "OK uuids-endpoint-count=$UC"
HAS_LANDING_BUNDLE=$(printf '%s' "$UDATA" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(typeof j.landingBundle==="string"&&j.landingBundle.startsWith("v1.")?"1":"0")}catch(e){process.stdout.write("0")}})')
if [ "$HAS_LANDING_BUNDLE" = "1" ]; then echo "OK landing-bundle-encrypted"; else echo "ERROR landing-bundle-missing"; exit 16; fi

echo "STEP canary-credential"
TEST_UUID="$NODE_UUID"
echo "::add-mask::$TEST_UUID"
echo "OK deployment-canary-uses-node-fallback"

echo "STEP policy-status"
STATUS_TS=$(date +%s)000
STATUS_PATH="/__opus8/policy/status?uuid=${TEST_UUID}"
STATUS_SIG=$(printf 'opus8-hmac-v2\n%s\n%s\n%s\n%s\n%s' \
  "$STATUS_TS" "$NODE_ID" "GET" "$STATUS_PATH" "" \
  | openssl dgst -sha256 -hmac "$NODE_HMAC_SECRET" -r | cut -d' ' -f1)
POLICY_STATUS=$(curl -fsS --max-time 20 \
  "${CUSTOM_URL}${STATUS_PATH}" \
  -H "x-opus8-ts: $STATUS_TS" \
  -H "x-opus8-node: $NODE_ID" \
  -H "x-opus8-sign-v2: $STATUS_SIG")
printf '%s' "$POLICY_STATUS" | node -e '
  let s="";
  process.stdin.on("data",d=>s+=d).on("end",()=>{
    const j=JSON.parse(s);
    const safe={
      invalidatedVersion:j.invalidatedVersion,
      cachedVersion:j.cachedVersion,
      cachedUuidCount:j.cachedUuidCount,
      cachedContainsUuid:j.cachedContainsUuid,
      cachedExpiresInMs:j.cachedExpiresInMs,
      liveOk:j.liveOk,
      liveStatus:j.liveStatus,
      liveVersion:j.liveVersion,
      liveUuidCount:j.liveUuidCount,
      liveContainsUuid:j.liveContainsUuid,
      liveError:j.liveError
    };
    console.log("INFO policy-status="+JSON.stringify(safe));
  })'

echo "STEP vless-smoke"
SMOKE_OK=0
SMOKE_VANTAGE="github-runner"
LEGACY_REMOTE_OK=0
for n in $(seq 1 8); do
  if python3 "$REPO_ROOT/infra/scripts/smoke-vless.py" --url "wss://${HOST}${TRANSPORT_URL_PATH}" --uuid "$TEST_UUID" --expect-status 0 >/tmp/vless.log 2>&1; then
    SMOKE_OK=1
    break
  fi
  sleep 8
done
if [ "$SMOKE_OK" != "1" ]; then
  echo "WARN vless-smoke vantage=github-runner failed; trying=landing-vps"
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
    REMOTE_TAG="$(printf '%s' "${GITHUB_RUN_ID:-manual}-${NODE_ID}" | tr -cd 'A-Za-z0-9._-')"
    REMOTE_SMOKE_PATH="/tmp/opus8-deploy-smoke-${REMOTE_TAG}.py"
    if "${SSH_BASE[@]}" 'command -v python3 >/dev/null' >/dev/null 2>&1 &&
      "${SCP_BASE[@]}" "$REPO_ROOT/infra/scripts/smoke-vless.py" \
        "$VPS_SSH_USER@$VPS_HOST:$REMOTE_SMOKE_PATH" >/dev/null 2>&1; then
      printf -v REMOTE_COMMAND '%q ' \
        python3 "$REMOTE_SMOKE_PATH" \
        --url "wss://${HOST}${TRANSPORT_URL_PATH}" \
        --uuid "$TEST_UUID" \
        --expect-status 0 \
        --timeout 20
      if "${SSH_BASE[@]}" "$REMOTE_COMMAND" >/tmp/vless-remote.log 2>&1; then
        SMOKE_OK=1
        SMOKE_VANTAGE="landing-vps"
        if [ -n "$TRANSPORT_LEGACY_PATH" ]; then
          printf -v REMOTE_LEGACY_COMMAND '%q ' \
            python3 "$REMOTE_SMOKE_PATH" \
            --url "wss://${HOST}${TRANSPORT_LEGACY_PATH}?ed=2560" \
            --uuid "$TEST_UUID" \
            --expect-status 0 \
            --timeout 20
          if "${SSH_BASE[@]}" "$REMOTE_LEGACY_COMMAND" \
            >/tmp/vless-legacy-remote.log 2>&1; then
            LEGACY_REMOTE_OK=1
          fi
        fi
      fi
      "${SSH_BASE[@]}" "rm -f -- '$REMOTE_SMOKE_PATH'" >/dev/null 2>&1 || true
    fi
  fi
fi

if [ "$SMOKE_OK" = "1" ]; then
  echo "OK vless-ws-auth-egress vantage=$SMOKE_VANTAGE"
else
  echo "ERROR vless-smoke all-available-vantages-failed"
  tail -n 3 /tmp/vless.log
  [ -f /tmp/vless-remote.log ] && tail -n 3 /tmp/vless-remote.log
  exit 17
fi

if [ -n "$TRANSPORT_LEGACY_PATH" ]; then
  echo "STEP transport-legacy-canary"
  LEGACY_OK="$LEGACY_REMOTE_OK"
  if [ "$LEGACY_OK" != "1" ]; then
    for n in $(seq 1 3); do
      if python3 "$REPO_ROOT/infra/scripts/smoke-vless.py" \
        --url "wss://${HOST}${TRANSPORT_LEGACY_PATH}?ed=2560" \
        --uuid "$TEST_UUID" \
        --expect-status 0 \
        --timeout 20 >/tmp/vless-legacy.log 2>&1; then
        LEGACY_OK=1
        break
      fi
      [ "$n" -lt 3 ] && sleep 4
    done
  fi
  if [ "$LEGACY_OK" = "1" ]; then
    echo "OK transport-legacy-grace"
  else
    echo "ERROR transport-legacy-grace"
    tail -n 3 /tmp/vless-legacy.log
    [ -f /tmp/vless-legacy-remote.log ] && tail -n 3 /tmp/vless-legacy-remote.log
    exit 17
  fi
fi

[ -n "$LAND" ] && echo "OK unlock=on(AI域名走落地)" || echo "INFO unlock=off"

if [ "$ENROLLMENT_KIND" = "migrate" ] || [ "$ENROLLMENT_KIND" = "rotate" ]; then
  echo "STEP retire-previous-credential"
  if node "$REPO_ROOT/infra/scripts/control-automation-request.mjs" DELETE \
    "$CONTROL_PLANE_URL/api/nodes/$NODE_ID/credential/previous" </dev/null \
    | grep -q '"ok":true'; then
    echo "OK previous-credential-retired"
  else
    echo "ERROR previous-credential-retirement"
    exit 18
  fi
fi

echo "DONE url=$URL"
