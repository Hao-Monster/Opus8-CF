#!/usr/bin/env bash
# 控制面部署脚本（在 GitHub Actions 里跑）。只打印自己的 marker 行，绝不打印任何密钥值。
set -euo pipefail
cd "$(dirname "$0")/../.."          # repo root
REPO_ROOT="$(pwd)"
export PATH="$REPO_ROOT/node_modules/.bin:$PATH"
echo "STEP compliance-policy"
COMPLIANCE_ENV="$(node "$REPO_ROOT/infra/scripts/compliance-gate.mjs" \
  --mode control-maintenance --format env)"
COMPLIANCE_PROXY_ALLOWED="$(printf '%s\n' "$COMPLIANCE_ENV" \
  | sed -n 's/^COMPLIANCE_PROXY_ALLOWED=//p')"
COMPLIANCE_ENFORCEMENT_MODE="$(printf '%s\n' "$COMPLIANCE_ENV" \
  | sed -n 's/^COMPLIANCE_ENFORCEMENT_MODE=//p')"
COMPLIANCE_POLICY_ID="$(printf '%s\n' "$COMPLIANCE_ENV" \
  | sed -n 's/^COMPLIANCE_POLICY_ID=//p')"
COMPLIANCE_MAINTENANCE_NODE_IDS="$(printf '%s\n' "$COMPLIANCE_ENV" \
  | sed -n 's/^COMPLIANCE_MAINTENANCE_NODE_IDS=//p')"
HMAC_V1_ACCEPT_UNTIL="$(printf '%s\n' "$COMPLIANCE_ENV" \
  | sed -n 's/^HMAC_V1_ACCEPT_UNTIL=//p')"
HMAC_V1_NODE_IDS="$(printf '%s\n' "$COMPLIANCE_ENV" \
  | sed -n 's/^HMAC_V1_NODE_IDS=//p')"
if ! printf '%s' "$COMPLIANCE_PROXY_ALLOWED" | grep -Eq '^[01]$' \
  || ! printf '%s' "$COMPLIANCE_ENFORCEMENT_MODE" \
    | grep -Eq '^(enforce|observe-only)$' \
  || ! printf '%s' "$COMPLIANCE_POLICY_ID" | grep -Eq '^[a-z0-9-]+$' \
  || ! printf '%s' "$COMPLIANCE_MAINTENANCE_NODE_IDS" \
    | grep -Eq '^[A-Za-z0-9._:-]+(,[A-Za-z0-9._:-]+)*$' \
  || ! printf '%s' "$HMAC_V1_ACCEPT_UNTIL" | grep -Eq '^[0-9]{13}$' \
  || ! printf '%s' "$HMAC_V1_NODE_IDS" \
    | grep -Eq '^[A-Za-z0-9._:-]+(,[A-Za-z0-9._:-]+)*$'; then
  echo "ERROR invalid-compliance-gate-output"
  exit 9
fi
export COMPLIANCE_PROXY_ALLOWED COMPLIANCE_ENFORCEMENT_MODE
export COMPLIANCE_POLICY_ID
export COMPLIANCE_MAINTENANCE_NODE_IDS
export HMAC_V1_ACCEPT_UNTIL HMAC_V1_NODE_IDS
echo "OK compliance-policy provisioning=$COMPLIANCE_PROXY_ALLOWED enforcement=$COMPLIANCE_ENFORCEMENT_MODE policy=$COMPLIANCE_POLICY_ID"
cd packages/control-plane

SUB_MAX_OPTIMIZED_IPS_PER_NODE="${SUB_MAX_OPTIMIZED_IPS_PER_NODE:-8}"
CLASH_ALIAS_SUNSET="${CLASH_ALIAS_SUNSET:-}"
if ! printf '%s' "$SUB_MAX_OPTIMIZED_IPS_PER_NODE" | grep -Eq '^[1-8]$'; then
  echo "ERROR invalid-subscription-ip-limit"
  exit 9
fi
if [ -n "$CLASH_ALIAS_SUNSET" ] \
  && ! printf '%s' "$CLASH_ALIAS_SUNSET" | grep -Eq '^[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$'; then
  echo "ERROR invalid-clash-alias-sunset"
  exit 9
fi

echo "STEP control-deploy-preflight"
if ! node ../../infra/scripts/control-deploy-preflight.mjs >/tmp/control-deploy-preflight.log 2>&1; then
  echo "ERROR control-deploy-preflight"
  tail -n 12 /tmp/control-deploy-preflight.log
  exit 9
fi
echo "OK control-deploy-preflight"

: "${ROOT_DOMAIN:?ROOT_DOMAIN is required for production custom domains}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"
: "${JWT_SECRET:?JWT_SECRET is required}"
: "${NODE_HMAC_SECRET:?NODE_HMAC_SECRET is required}"
: "${LANDING_CONFIG_KEY:?LANDING_CONFIG_KEY is required}"
: "${AUTOMATION_HMAC_SECRET:?AUTOMATION_HMAC_SECRET is required}"
RETIRE_PREVIOUS_SECRET="${RETIRE_PREVIOUS_SECRET:-none}"
case "$RETIRE_PREVIOUS_SECRET" in
  none) ;;
  jwt)
    [ -z "${JWT_SECRET_PREVIOUS:-}" ] || {
      echo "ERROR remove JWT_SECRET_PREVIOUS GitHub Secret before retirement"
      exit 9
    }
    ;;
  node-hmac)
    [ -z "${NODE_HMAC_SECRET_PREVIOUS:-}" ] || {
      echo "ERROR remove NODE_HMAC_SECRET_PREVIOUS GitHub Secret before retirement"
      exit 9
    }
    ;;
  landing-config)
    [ -z "${LANDING_CONFIG_KEY_PREVIOUS:-}" ] || {
      echo "ERROR remove LANDING_CONFIG_KEY_PREVIOUS GitHub Secret before retirement"
      exit 9
    }
    ;;
  all)
    if [ -n "${JWT_SECRET_PREVIOUS:-}" ] \
      || [ -n "${NODE_HMAC_SECRET_PREVIOUS:-}" ] \
      || [ -n "${LANDING_CONFIG_KEY_PREVIOUS:-}" ]; then
      echo "ERROR remove all previous-key GitHub Secrets before retirement"
      exit 9
    fi
    ;;
  *)
    echo "ERROR invalid RETIRE_PREVIOUS_SECRET"
    exit 9
    ;;
esac
ROOT_DOMAIN="${ROOT_DOMAIN#https://}"
ROOT_DOMAIN="${ROOT_DOMAIN#http://}"
ROOT_DOMAIN="${ROOT_DOMAIN%%/*}"
API_HOST="api.${ROOT_DOMAIN}"
SUB_HOST="sub.${ROOT_DOMAIN}"
API_URL="https://${API_HOST}"
SUB_URL="https://${SUB_HOST}"
ADMIN_UI_ORIGINS="${ADMIN_UI_ORIGINS:-https://opus8cf-admin-openal.pages.dev}"
if ! ADMIN_UI_PRIMARY_ORIGIN=$(
  ADMIN_UI_ORIGINS="$ADMIN_UI_ORIGINS" node -e '
    const values=String(process.env.ADMIN_UI_ORIGINS||"").split(",").map(x=>x.trim()).filter(Boolean);
    if(!values.length) process.exit(1);
    for(const value of values){
      let url;
      try{url=new URL(value)}catch{process.exit(1)}
      if(!["https:","http:"].includes(url.protocol)||url.username||url.password||
        (url.pathname!=="/"&&url.pathname!=="")||url.search||url.hash) process.exit(1);
    }
    process.stdout.write(new URL(values[0]).origin);
  '
); then
  echo "ERROR invalid-admin-ui-origins"
  exit 9
fi
DEFAULT_UNLOCK_HOSTS=$(grep -E '^[A-Za-z0-9.-]+$' ../../infra/ai-unlock.txt | tr '[:upper:]' '[:lower:]' | paste -sd, -)
OPUS8_BUILD_ID="${GITHUB_SHA:-manual}-${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-0}"
SUB_SOURCE_RATE_LIMIT=120
SUB_TOKEN_RATE_LIMIT=20
ADMIN_LOGIN_RATE_LIMIT=10
SUB_RATE_LIMIT_PERIOD=60

echo "STEP ensure-d1-kv"
wrangler_with_retry() {
  local label="$1"
  shift
  local attempt output delay=5
  for attempt in 1 2 3 4 5 6 7 8; do
    if output=$(wrangler "$@" 2>/tmp/opus8-wrangler-api.log); then
      printf '%s' "$output"
      return 0
    fi
    if grep -Eqi '10429|rate[ -]?limit' /tmp/opus8-wrangler-api.log; then
      echo "WARN cloudflare-rate-limit operation=$label attempt=$attempt retryIn=${delay}s" >&2
      sleep "$delay"
      delay=$((delay < 30 ? delay * 2 : 30))
      continue
    fi
    echo "ERROR cloudflare-api operation=$label" >&2
    tail -n 8 /tmp/opus8-wrangler-api.log \
      | sed 's/[A-Za-z0-9_-]\{24,\}/<redacted>/g' >&2
    return 1
  done
  echo "ERROR cloudflare-rate-limit-exhausted operation=$label" >&2
  return 1
}

D1_LIST=$(wrangler_with_retry d1-list d1 list --json)
DBID=$(printf '%s' "$D1_LIST" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const x=a.find(r=>r.name==="opus8cf-db");process.stdout.write(x?(x.uuid||x.database_id||""):"")}catch(e){process.stdout.write("")}})')
if [ -z "$DBID" ]; then
  wrangler_with_retry d1-create d1 create opus8cf-db >/dev/null
  D1_LIST=$(wrangler_with_retry d1-list d1 list --json)
  DBID=$(printf '%s' "$D1_LIST" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const x=a.find(r=>r.name==="opus8cf-db");process.stdout.write(x?(x.uuid||x.database_id||""):"")}catch(e){process.stdout.write("")}})')
fi
unset D1_LIST

KV_LIST=$(wrangler_with_retry kv-list kv namespace list)
KVID=$(printf '%s' "$KV_LIST" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const x=a.find(r=>r.title&&r.title.includes("OPUS8_KV"));process.stdout.write(x?x.id:"")}catch(e){process.stdout.write("")}})')
if [ -z "$KVID" ]; then
  wrangler_with_retry kv-create kv namespace create OPUS8_KV >/dev/null
  KV_LIST=$(wrangler_with_retry kv-list kv namespace list)
  KVID=$(printf '%s' "$KV_LIST" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const x=a.find(r=>r.title&&r.title.includes("OPUS8_KV"));process.stdout.write(x?x.id:"")}catch(e){process.stdout.write("")}})')
fi
unset KV_LIST

if [ -z "$DBID" ] || [ -z "$KVID" ]; then
  echo "ERROR resolve-id-failed (token 可能缺少 D1/KV 编辑权限)"
  exit 10
fi
echo "OK ids-resolved d1=${DBID:0:8}… kv=${KVID:0:8}…"

cat > wrangler.toml <<EOF
name = "opus8cf-control"
main = "dist/index.js"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true

[vars]
DEFAULT_UNLOCK_HOSTS = "$DEFAULT_UNLOCK_HOSTS"
OPUS8_BUILD_ID = "$OPUS8_BUILD_ID"
USE_OPTIMIZED_IPS = "1"
SUB_MAX_OPTIMIZED_IPS_PER_NODE = "$SUB_MAX_OPTIMIZED_IPS_PER_NODE"
CLASH_ALIAS_SUNSET = "$CLASH_ALIAS_SUNSET"
ADMIN_UI_ORIGINS = "$ADMIN_UI_ORIGINS"
HMAC_V1_ACCEPT_UNTIL = "$HMAC_V1_ACCEPT_UNTIL"
HMAC_V1_NODE_IDS = "$HMAC_V1_NODE_IDS"
SUB_RATE_LIMIT_REQUIRED = "1"
ADMIN_LOGIN_RATE_LIMIT_REQUIRED = "1"
AUTOMATION_ALLOWED_IDS = "github-node-deploy"
COMPLIANCE_PROXY_ALLOWED = "$COMPLIANCE_PROXY_ALLOWED"
COMPLIANCE_ENFORCEMENT_MODE = "$COMPLIANCE_ENFORCEMENT_MODE"
COMPLIANCE_POLICY_ID = "$COMPLIANCE_POLICY_ID"
COMPLIANCE_MAINTENANCE_NODE_IDS = "$COMPLIANCE_MAINTENANCE_NODE_IDS"

[triggers]
crons = ["17 */6 * * *"]

[observability.logs]
enabled = true
head_sampling_rate = 0.05

[observability.traces]
enabled = true
head_sampling_rate = 0.01

[[ratelimits]]
name = "SUB_SOURCE_RATE_LIMITER"
namespace_id = "683401"

  [ratelimits.simple]
  limit = $SUB_SOURCE_RATE_LIMIT
  period = $SUB_RATE_LIMIT_PERIOD

[[ratelimits]]
name = "SUB_TOKEN_RATE_LIMITER"
namespace_id = "683402"

  [ratelimits.simple]
  limit = $SUB_TOKEN_RATE_LIMIT
  period = $SUB_RATE_LIMIT_PERIOD

[[ratelimits]]
name = "ADMIN_LOGIN_RATE_LIMITER"
namespace_id = "683403"

  [ratelimits.simple]
  limit = $ADMIN_LOGIN_RATE_LIMIT
  period = $SUB_RATE_LIMIT_PERIOD

[[d1_databases]]
binding = "DB"
database_name = "opus8cf-db"
database_id = "$DBID"

[[kv_namespaces]]
binding = "KV"
id = "$KVID"

[[routes]]
pattern = "$API_HOST"
custom_domain = true

[[routes]]
pattern = "$SUB_HOST"
custom_domain = true
EOF

echo "STEP apply-schema"
if ! wrangler d1 execute opus8cf-db --remote --file=schema.sql >/tmp/schema.log 2>&1; then
  echo "ERROR schema-failed"; tail -n 3 /tmp/schema.log | sed 's/[A-Za-z0-9_-]\{24,\}/<redacted>/g'; exit 11
fi
if ! NODE_COLUMNS=$(wrangler d1 execute opus8cf-db --remote \
  --command 'PRAGMA table_info(nodes);' --json 2>/tmp/schema-columns.log); then
  echo "ERROR schema-column-inspection"
  tail -n 3 /tmp/schema-columns.log
  exit 11
fi
HAS_TRANSPORT_PATH=$(printf '%s' "$NODE_COLUMNS" | node -e '
  let s="";
  process.stdin.on("data",d=>s+=d).on("end",()=>{
    try {
      const value=JSON.parse(s);
      const rows=Array.isArray(value)?value.flatMap(x=>x.results||[]):[];
      process.stdout.write(rows.some(x=>x.name==="transport_path")?"1":"0");
    } catch { process.stdout.write("0"); }
  });
')
if [ "$HAS_TRANSPORT_PATH" != "1" ]; then
  if ! wrangler d1 execute opus8cf-db --remote \
    --command "ALTER TABLE nodes ADD COLUMN transport_path TEXT NOT NULL DEFAULT '/';" \
    >/tmp/schema-transport.log 2>&1; then
    echo "ERROR schema-transport-path-migration"
    tail -n 3 /tmp/schema-transport.log
    exit 11
  fi
  echo "OK schema-migrated transport_path"
fi
echo "OK schema-applied"

echo "STEP cors-test"
if ! node test/cors-test.mjs >/tmp/cors-test.log 2>&1; then
  echo "ERROR cors-test"; tail -n 8 /tmp/cors-test.log; exit 12
fi
echo "OK cors-test"
if ! node test/signature-test.mjs >/tmp/signature-test.log 2>&1; then
  echo "ERROR signature-test"; tail -n 8 /tmp/signature-test.log; exit 12
fi
echo "OK signature-test"
if ! node test/integration-auth-test.mjs >/tmp/integration-auth-test.log 2>&1; then
  echo "ERROR integration-auth-test"; tail -n 8 /tmp/integration-auth-test.log; exit 12
fi
echo "OK integration-auth-test"
if ! node test/webmaster-benefit-test.mjs >/tmp/webmaster-benefit-test.log 2>&1; then
  echo "ERROR webmaster-benefit-test"; tail -n 8 /tmp/webmaster-benefit-test.log; exit 12
fi
echo "OK webmaster-benefit-test"
if ! node test/deployment-preflight-test.mjs >/tmp/deployment-preflight-test.log 2>&1; then
  echo "ERROR deployment-preflight-test"; tail -n 8 /tmp/deployment-preflight-test.log; exit 12
fi
echo "OK deployment-preflight-test"
if ! node test/key-rotation-test.mjs >/tmp/key-rotation-test.log 2>&1; then
  echo "ERROR key-rotation-test"; tail -n 8 /tmp/key-rotation-test.log; exit 12
fi
echo "OK key-rotation-test"
if ! node test/d1-backup-crypto-test.mjs >/tmp/d1-backup-test.log 2>&1; then
  echo "ERROR d1-backup-test"; tail -n 8 /tmp/d1-backup-test.log; exit 12
fi
echo "OK d1-backup-test"
if ! node test/subscription-rate-limit-test.mjs >/tmp/sub-rate-test.log 2>&1; then
  echo "ERROR subscription-rate-limit-test"; tail -n 8 /tmp/sub-rate-test.log; exit 12
fi
echo "OK subscription-rate-limit-test"
if ! node test/subscription-renderer-test.mjs >/tmp/subscription-renderer-test.log 2>&1; then
  echo "ERROR subscription-renderer-test"; tail -n 8 /tmp/subscription-renderer-test.log; exit 12
fi
echo "OK subscription-renderer-test"
if ! node test/subscription-rules-test.mjs >/tmp/subscription-rules-test.log 2>&1; then
  echo "ERROR subscription-rules-test"; tail -n 8 /tmp/subscription-rules-test.log; exit 12
fi
echo "OK subscription-rules-test"
if ! node test/optimized-ip-selection-test.mjs >/tmp/optimized-ip-selection-test.log 2>&1; then
  echo "ERROR optimized-ip-selection-test"; tail -n 8 /tmp/optimized-ip-selection-test.log; exit 12
fi
echo "OK optimized-ip-selection-test"
if ! node test/device-credentials-test.mjs >/tmp/device-credentials-test.log 2>&1; then
  echo "ERROR device-credentials-test"; tail -n 8 /tmp/device-credentials-test.log; exit 12
fi
echo "OK device-credentials-test"
if ! node test/compliance-test.mjs >/tmp/compliance-test.log 2>&1; then
  echo "ERROR compliance-test"; tail -n 8 /tmp/compliance-test.log; exit 12
fi
echo "OK compliance-test"
if ! node test/resource-audit-test.mjs >/tmp/resource-audit-test.log 2>&1; then
  echo "ERROR resource-audit-test"; tail -n 8 /tmp/resource-audit-test.log; exit 12
fi
echo "OK resource-audit-test"
if ! node test/transport-path-test.mjs >/tmp/transport-path-test.log 2>&1; then
  echo "ERROR transport-path-test"; tail -n 8 /tmp/transport-path-test.log; exit 12
fi
echo "OK transport-path-test"
if ! node test/schema-transport-migration-test.mjs >/tmp/schema-migration-test.log 2>&1; then
  echo "ERROR schema-migration-test"; tail -n 8 /tmp/schema-migration-test.log; exit 12
fi
echo "OK schema-migration-test"
if ! node test/client-compatibility-test.mjs >/tmp/client-compatibility-test.log 2>&1; then
  echo "ERROR client-compatibility-test"; tail -n 8 /tmp/client-compatibility-test.log; exit 12
fi
echo "OK client-compatibility-test"
if ! node test/supply-chain-test.mjs >/tmp/supply-chain-test.log 2>&1; then
  echo "ERROR supply-chain-test"; tail -n 8 /tmp/supply-chain-test.log; exit 12
fi
echo "OK supply-chain-test"

echo "STEP bundle"
if ! esbuild src/index.ts --bundle --format=esm --external:cloudflare:sockets --loader:.yaml=text --outfile=dist/index.js --alias:@opus8-cf/shared=../shared/src/index.ts >/tmp/bundle.log 2>&1; then
  echo "ERROR bundle-failed"; tail -n 5 /tmp/bundle.log; exit 12
fi
echo "OK bundled"
echo "STEP subscription-rules"
if ! node ../../infra/scripts/verify-subscription-rules.mjs >/tmp/subscription-rules.log 2>&1; then
  echo "ERROR subscription-rule-verification"; tail -n 8 /tmp/subscription-rules.log; exit 12
fi
while IFS=$'\t' read -r rule_key rule_path rule_sha256; do
  if ! wrangler kv key put "$rule_key" \
    --path "../../infra/subscription-rules/v1/$rule_path" \
    --binding KV --remote >/tmp/subscription-rule-upload.log 2>&1; then
    echo "ERROR subscription-rule-upload path=$rule_path"
    tail -n 5 /tmp/subscription-rule-upload.log
    exit 12
  fi
  echo "OK subscription-rule-upload path=$rule_path sha256=$rule_sha256"
done < <(node ../../infra/scripts/verify-subscription-rules.mjs --list)
echo "OK subscription-rules-uploaded"
if ! node test/compliance-runtime-local.mjs >/tmp/compliance-runtime-test.log 2>&1; then
  echo "ERROR compliance-runtime-test"; tail -n 12 /tmp/compliance-runtime-test.log; exit 12
fi
echo "OK compliance-runtime-test"
if ! node test/integration-local.mjs >/tmp/integration-runtime-test.log 2>&1; then
  echo "ERROR integration-runtime-test"; tail -n 16 /tmp/integration-runtime-test.log; exit 12
fi
echo "OK integration-runtime-test"

echo "STEP deploy"
PREVIOUS_VERSION_ID="$(wrangler deployments list --name opus8cf-control --json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const x=JSON.parse(s);process.stdout.write(String(x?.[0]?.versions?.[0]?.version_id||""))}catch{}})')"
if [ -z "$PREVIOUS_VERSION_ID" ]; then
  echo "ERROR previous-worker-version-unavailable"
  exit 13
fi
DEPLOYED_NEW_VERSION=0
RELEASE_VERIFIED=0
rollback_unverified_release() {
  local exit_code=$?
  trap - EXIT
  if [ "$exit_code" -ne 0 ] \
    && [ "$DEPLOYED_NEW_VERSION" = "1" ] \
    && [ "$RELEASE_VERIFIED" != "1" ]; then
    echo "STEP automatic-rollback previousVersion=$PREVIOUS_VERSION_ID"
    if wrangler rollback "$PREVIOUS_VERSION_ID" --name opus8cf-control \
      --message "Automatic rollback after failed Opus8 subscription smoke" \
      --yes >/tmp/automatic-rollback.log 2>&1; then
      echo "OK automatic-rollback"
    else
      echo "ERROR automatic-rollback-failed"
      tail -n 8 /tmp/automatic-rollback.log \
        | sed 's/[A-Za-z0-9_-]\{24,\}/<redacted>/g'
    fi
  fi
  exit "$exit_code"
}
trap rollback_unverified_release EXIT
DEPLOYED_NEW_VERSION=1
if ! wrangler deploy >/tmp/wd.log 2>&1; then
  echo "ERROR deploy-failed"; tail -n 6 /tmp/wd.log | sed 's/[A-Za-z0-9_-]\{24,\}/<redacted>/g'; exit 13
fi
WORKERS_URL=$(grep -oE 'https://[a-z0-9._-]+workers\.dev' /tmp/wd.log | head -n1 || true)
echo "OK deployed workers=${WORKERS_URL:-unreported} custom=$API_URL"

echo "STEP subscription-waf"
SUB_WAF_MODE="${SUB_WAF_MODE:-optional}" \
  bash ../../infra/scripts/configure-subscription-waf.sh

echo "STEP secrets"
put_secret() {
  local name="$1"
  local value="$2"
  if ! printf '%s' "$value" | wrangler secret put "$name" >/dev/null 2>&1; then
    echo "ERROR secret-update-failed name=$name"
    exit 13
  fi
  echo "OK secret $name"
}

put_previous_secret() {
  local name="$1"
  local previous="$2"
  local current="$3"
  if [ -n "$previous" ] && [ "$previous" != "$current" ]; then
    put_secret "$name" "$previous"
  fi
}

# Install fallback bindings before changing current keys, so the version
# transition never creates a reject-all interval.
put_previous_secret JWT_SECRET_PREVIOUS \
  "${JWT_SECRET_PREVIOUS:-}" "$JWT_SECRET"
put_previous_secret NODE_HMAC_SECRET_PREVIOUS \
  "${NODE_HMAC_SECRET_PREVIOUS:-}" "$NODE_HMAC_SECRET"
put_previous_secret LANDING_CONFIG_KEY_PREVIOUS \
  "${LANDING_CONFIG_KEY_PREVIOUS:-}" "$LANDING_CONFIG_KEY"
put_secret ADMIN_PASSWORD "$ADMIN_PASSWORD"
put_secret JWT_SECRET "$JWT_SECRET"
put_secret NODE_HMAC_SECRET "$NODE_HMAC_SECRET"
put_secret LANDING_CONFIG_KEY "$LANDING_CONFIG_KEY"
put_secret "FREEDOMPOST_INTEGRATION_KEY_ID" "$FREEDOMPOST_INTEGRATION_KEY_ID"
put_secret "FREEDOMPOST_INTEGRATION_SECRET" "$FREEDOMPOST_INTEGRATION_SECRET"
put_secret "AUTOMATION_HMAC_SECRET" "$AUTOMATION_HMAC_SECRET"
put_secret ROOT_DOMAIN "$ROOT_DOMAIN"
put_secret SUB_BASE "$SUB_URL"

if [ "$RETIRE_PREVIOUS_SECRET" != "none" ]; then
  echo "STEP retire-previous-secrets"
  retire_names=()
  case "$RETIRE_PREVIOUS_SECRET" in
    jwt) retire_names=(JWT_SECRET_PREVIOUS) ;;
    node-hmac) retire_names=(NODE_HMAC_SECRET_PREVIOUS) ;;
    landing-config) retire_names=(LANDING_CONFIG_KEY_PREVIOUS) ;;
    all)
      retire_names=(
        JWT_SECRET_PREVIOUS
        NODE_HMAC_SECRET_PREVIOUS
        LANDING_CONFIG_KEY_PREVIOUS
      )
      ;;
  esac
  for name in "${retire_names[@]}"; do
    if ! printf 'y\n' | wrangler secret delete "$name" >/dev/null 2>&1; then
      echo "ERROR previous-secret-retirement-failed name=$name"
      exit 13
    fi
    echo "OK retired $name"
  done
fi

echo "STEP wait-deployed-version"
VERSION_READY=0
for n in $(seq 1 36); do
  CUSTOM_BUILD=$(curl -fsS --max-time 12 "$API_URL/__opus8/build" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).buildId||""))}catch(e){}})' || true)
  WORKERS_BUILD="$OPUS8_BUILD_ID"
  if [ -n "$WORKERS_URL" ]; then
    WORKERS_BUILD=$(curl -fsS --max-time 12 "$WORKERS_URL/__opus8/build" 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).buildId||""))}catch(e){}})' || true)
  fi
  if [ "$CUSTOM_BUILD" = "$OPUS8_BUILD_ID" ] && [ "$WORKERS_BUILD" = "$OPUS8_BUILD_ID" ]; then
    VERSION_READY=1
    break
  fi
  sleep 5
done
if [ "$VERSION_READY" != "1" ]; then
  echo "ERROR deployed-version-not-active"
  exit 14
fi
echo "OK deployed-version-active custom=1 workers=1"

echo "STEP wait-custom-domain"
CUSTOM_OK=0
for n in $(seq 1 24); do
  if curl -fsS --max-time 15 "$API_URL/health" | grep -q '"ok":true'; then CUSTOM_OK=1; break; fi
  sleep 10
done
if [ "$CUSTOM_OK" != "1" ]; then echo "ERROR custom-domain-unreachable"; exit 15; fi
echo "OK custom-domain-ready api=$API_URL sub=$SUB_URL"

echo "STEP smoke-subscription-rules"
while IFS=$'\t' read -r _rule_key rule_path rule_sha256; do
  if ! curl -fsS --max-time 30 \
    "$SUB_URL/rules/v1/$rule_path" -o /tmp/subscription-rule-smoke.bin \
    || ! printf '%s  %s\n' "$rule_sha256" /tmp/subscription-rule-smoke.bin \
      | sha256sum -c - >/dev/null; then
    echo "ERROR smoke-subscription-rule path=$rule_path"
    exit 15
  fi
done < <(node ../../infra/scripts/verify-subscription-rules.mjs --list)
echo "OK smoke-subscription-rules"

echo "STEP smoke"
if curl -fsS --max-time 15 "$API_URL/health" | grep -q '"ok":true'; then echo "OK smoke-health"; else echo "ERROR smoke-health"; exit 15; fi
TOK=""
for n in $(seq 1 18); do
  LOGIN=$(curl -s --max-time 15 -X POST "$API_URL/api/admin/login" -H 'content-type: application/json' -d "{\"password\":\"${ADMIN_PASSWORD:-}\"}" || true)
  TOK=$(printf '%s' "$LOGIN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).token||"")}catch(e){process.stdout.write("")}})')
  if [ -n "$TOK" ]; then
    MECODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$API_URL/api/admin/me" -H "authorization: Bearer $TOK" || true)
    [ "$MECODE" = "200" ] && break
    TOK=""
  fi
  sleep 5
done
if [ -n "$TOK" ]; then echo "OK smoke-login"; else echo "ERROR smoke-login"; exit 16; fi

REMOTE_COMPLIANCE=$(curl -fsS --max-time 15 \
  "$API_URL/api/operations/compliance" \
  -H "authorization: Bearer $TOK")
if ! printf '%s' "$REMOTE_COMPLIANCE" \
  | EXPECTED_ALLOWED="$COMPLIANCE_PROXY_ALLOWED" EXPECTED_ENFORCEMENT="$COMPLIANCE_ENFORCEMENT_MODE" EXPECTED_POLICY="$COMPLIANCE_POLICY_ID" \
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);const expected=process.env.EXPECTED_ALLOWED==="1";process.exit(x.proxyProvisioningAllowed===expected&&x.enforcement===process.env.EXPECTED_ENFORCEMENT&&x.policyId===process.env.EXPECTED_POLICY?0:1)})'; then
  echo "ERROR smoke-compliance-state"
  exit 16
fi
echo "OK smoke-compliance-state provisioning=$COMPLIANCE_PROXY_ALLOWED"

ROTATION_STATE_OK=0
for n in $(seq 1 18); do
  REMOTE_ROTATION=$(curl -fsS --max-time 15 \
    "$API_URL/api/operations/key-rotation" \
    -H "authorization: Bearer $TOK" 2>/dev/null || true)
  if printf '%s' "$REMOTE_ROTATION" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const x=JSON.parse(s);const c=x.landingCredentials||{};const valid=Number.isInteger(c.total)&&Number.isInteger(c.current)&&Number.isInteger(c.previous)&&c.unreadable===0&&c.current+c.previous===c.total;process.exit(valid?0:1)}catch{process.exit(1)}})'; then
    ROTATION_STATE_OK=1
    break
  fi
  sleep 3
done
if [ "$ROTATION_STATE_OK" != "1" ]; then
  echo "ERROR smoke-key-rotation-state"
  exit 16
fi
echo "OK smoke-key-rotation-state unreadable=0"

REMOTE_SLO=$(curl -fsS --max-time 15 \
  "$API_URL/api/operations/slo" \
  -H "authorization: Bearer $TOK")
if ! printf '%s' "$REMOTE_SLO" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const x=JSON.parse(s);process.exit(["ok","degraded"].includes(x.status)&&typeof x.checks?.retentionCurrent==="boolean"?0:1)}catch{process.exit(1)}})'; then
  echo "ERROR smoke-operations-slo"
  exit 16
fi
echo "OK smoke-operations-slo"

REMOTE_AUDIT=$(curl -fsS --max-time 15 \
  "$API_URL/api/operations/audit?limit=1" \
  -H "authorization: Bearer $TOK")
if ! printf '%s' "$REMOTE_AUDIT" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(Array.isArray(JSON.parse(s).entries)?0:1)}catch{process.exit(1)}})'; then
  echo "ERROR smoke-admin-audit"
  exit 16
fi
echo "OK smoke-admin-audit"

echo "STEP cors-regression"
PREFLIGHT_OK=0
PREFLIGHT_CODE=000
for n in $(seq 1 18); do
  PREFLIGHT_CODE=$(curl -sS -o /tmp/cors-preflight.body \
    -D /tmp/cors-preflight.headers -w '%{http_code}' --max-time 15 \
    -X OPTIONS "$API_URL/api/users" \
    -H "Origin: $ADMIN_UI_PRIMARY_ORIGIN" \
    -H 'Access-Control-Request-Method: GET' \
    -H 'Access-Control-Request-Headers: authorization' || true)
  if [ "$PREFLIGHT_CODE" = "204" ] \
    && grep -Fqi "access-control-allow-origin: $ADMIN_UI_PRIMARY_ORIGIN" /tmp/cors-preflight.headers \
    && ! grep -qi '^access-control-allow-credentials:' /tmp/cors-preflight.headers; then
    PREFLIGHT_OK=1
    break
  fi
  sleep 3
done
if [ "$PREFLIGHT_OK" != "1" ]; then
  echo "ERROR cors-allowed-preflight http=$PREFLIGHT_CODE"
  exit 16
fi

DENIED_CODE=$(curl -sS -o /tmp/cors-denied.body -D /tmp/cors-denied.headers \
  -w '%{http_code}' --max-time 15 -X OPTIONS "$API_URL/api/users" \
  -H 'Origin: https://cors-denied.invalid' \
  -H 'Access-Control-Request-Method: GET' || true)
if [ "$DENIED_CODE" != "403" ] \
  || grep -qi '^access-control-allow-origin:' /tmp/cors-denied.headers; then
  echo "ERROR cors-denied-origin http=$DENIED_CODE"
  exit 16
fi

NODE_CORS_CODE=$(curl -sS -o /tmp/cors-node.body -D /tmp/cors-node.headers \
  -w '%{http_code}' --max-time 15 -X OPTIONS "$API_URL/api/nodes/register" \
  -H "Origin: $ADMIN_UI_PRIMARY_ORIGIN" \
  -H 'Access-Control-Request-Method: POST' || true)
if [ "$NODE_CORS_CODE" != "404" ] \
  || grep -qi '^access-control-allow-origin:' /tmp/cors-node.headers; then
  echo "ERROR cors-node-api-exposed http=$NODE_CORS_CODE"
  exit 16
fi

ADMIN_CORS_CODE=$(curl -sS -o /tmp/cors-admin.body -D /tmp/cors-admin.headers \
  -w '%{http_code}' --max-time 15 "$API_URL/api/admin/me" \
  -H "Origin: $ADMIN_UI_PRIMARY_ORIGIN" \
  -H "authorization: Bearer $TOK" || true)
if [ "$ADMIN_CORS_CODE" != "200" ] \
  || ! grep -Fqi "access-control-allow-origin: $ADMIN_UI_PRIMARY_ORIGIN" /tmp/cors-admin.headers; then
  echo "ERROR cors-admin-response http=$ADMIN_CORS_CODE"
  exit 16
fi

PRIVATE_CORS_CODE=$(curl -sS -o /tmp/cors-private.body -D /tmp/cors-private.headers \
  -w '%{http_code}' --max-time 15 "$API_URL/api/node-enrollments" \
  -H "Origin: $ADMIN_UI_PRIMARY_ORIGIN" \
  -H "authorization: Bearer $TOK" || true)
if [ "$PRIVATE_CORS_CODE" != "200" ] \
  || ! grep -Fqi "access-control-allow-origin: $ADMIN_UI_PRIMARY_ORIGIN" /tmp/cors-private.headers \
  || ! grep -qi '^cache-control: no-store' /tmp/cors-private.headers; then
  echo "ERROR cors-private-response http=$PRIVATE_CORS_CODE"
  exit 16
fi

PRIVATE_ERROR_CORS_CODE=$(curl -sS -o /tmp/cors-private-error.body \
  -D /tmp/cors-private-error.headers -w '%{http_code}' --max-time 15 \
  -X POST "$API_URL/api/node-enrollments" \
  -H "Origin: $ADMIN_UI_PRIMARY_ORIGIN" \
  -H "authorization: Bearer $TOK" \
  -H 'content-type: application/json' \
  -d '{"nodeId":"invalid node id"}' || true)
if [ "$PRIVATE_ERROR_CORS_CODE" != "400" ] \
  || ! grep -Fqi "access-control-allow-origin: $ADMIN_UI_PRIMARY_ORIGIN" /tmp/cors-private-error.headers \
  || ! grep -qi '^cache-control: no-store' /tmp/cors-private-error.headers; then
  echo "ERROR cors-private-error-response http=$PRIVATE_ERROR_CORS_CODE"
  exit 16
fi

HEALTH_CORS_CODE=$(curl -sS -o /tmp/cors-health.body -D /tmp/cors-health.headers \
  -w '%{http_code}' --max-time 15 "$API_URL/health" \
  -H "Origin: $ADMIN_UI_PRIMARY_ORIGIN" || true)
if [ "$HEALTH_CORS_CODE" != "200" ] \
  || grep -qi '^access-control-allow-origin:' /tmp/cors-health.headers; then
  echo "ERROR cors-non-admin-api-exposed http=$HEALTH_CORS_CODE"
  exit 16
fi
echo "OK cors-admin-only"

echo "STEP ensure-default-landing"
LANDINGS=$(curl -fsS --max-time 15 "$API_URL/api/landings" -H "authorization: Bearer $TOK")
LCOUNT=$(printf '%s' "$LANDINGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String((JSON.parse(s).landings||[]).length))}catch(e){process.stdout.write("0")}})')
if [ "$LCOUNT" -eq 0 ] && [ "$COMPLIANCE_PROXY_ALLOWED" != "1" ]; then
  echo "OK default-landing-provisioning-skipped compliance=blocked"
elif [ "$LCOUNT" -eq 0 ]; then
  if [ -z "${SERVICES_IP:-}" ] || [ -z "${SERVICES_USER:-}" ] || [ -z "${SERVICES_CODE:-}" ]; then
    echo "ERROR default-landing-secrets-missing"
    exit 17
  fi
  LANDING_SEED=$(node -e 'process.stdout.write(JSON.stringify({name:"默认落地机",hostname:process.env.SERVICES_IP,port:40008,username:process.env.SERVICES_USER,password:process.env.SERVICES_CODE,region:"default",matchHosts:[],priority:100,enabled:true}))')
  CREATE_CODE=000
  for n in $(seq 1 8); do
    CREATE_CODE=$(curl -sS -o /tmp/landing-create.json -w '%{http_code}' --max-time 20 -X POST "$API_URL/api/landings" -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d "$LANDING_SEED" || true)
    if [ "$CREATE_CODE" = "201" ]; then break; fi
    # 首次写入 Worker Secret 后各边缘位置可能短暂仍读到旧配置；同时检查是否已写入，避免超时重试产生重复记录。
    LANDINGS=$(curl -fsS --max-time 15 "$API_URL/api/landings" -H "authorization: Bearer $TOK" || true)
    LCOUNT=$(printf '%s' "$LANDINGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String((JSON.parse(s).landings||[]).length))}catch(e){process.stdout.write("0")}})')
    if [ "$LCOUNT" -gt 0 ]; then CREATE_CODE=existing; break; fi
    sleep 3
  done
  if [ "$CREATE_CODE" != "201" ] && [ "$CREATE_CODE" != "existing" ]; then
    CREATE_ERROR=$(node -e 'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync("/tmp/landing-create.json","utf8"));process.stdout.write(String(j.error||"unknown").slice(0,200))}catch(e){process.stdout.write("invalid response")}')
    echo "ERROR default-landing-create http=$CREATE_CODE reason=$CREATE_ERROR" | sed 's/[A-Za-z0-9_-]\{24,\}/<redacted>/g'
    exit 18
  fi
  if [ "$CREATE_CODE" = "201" ]; then
    CREATED=$(cat /tmp/landing-create.json)
    CREATED_ID=$(printf '%s' "$CREATED" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).landing.id||"")}catch(e){}})')
    if [ -z "$CREATED_ID" ]; then echo "ERROR default-landing-create"; exit 18; fi
  fi
  echo "OK default-landing-imported"
  LANDINGS=$(curl -fsS --max-time 15 "$API_URL/api/landings" -H "authorization: Bearer $TOK")
  LCOUNT=$(printf '%s' "$LANDINGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String((JSON.parse(s).landings||[]).length))}catch(e){process.stdout.write("0")}})')
fi
echo "OK smoke-landings count=$LCOUNT"
LANDING_ID=$(printf '%s' "$LANDINGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write((JSON.parse(s).landings||[])[0]?.id||"")}catch(e){}})')
if [ -n "$LANDING_ID" ]; then
  TEST_CODE=$(curl -sS -o /tmp/landing-test.json -w '%{http_code}' --max-time 25 -X POST "$API_URL/api/landings/$LANDING_ID/test" -H "authorization: Bearer $TOK" || true)
  if [ "$TEST_CODE" = "200" ]; then
    echo "OK smoke-landing-socks5"
  else
    echo "ERROR smoke-landing-socks5 http=$TEST_CODE"
    exit 19
  fi
fi

ROUTES=$(curl -fsS --max-time 15 "$API_URL/api/settings/unlock-hosts" -H "authorization: Bearer $TOK")
RCOUNT=$(printf '%s' "$ROUTES" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String((JSON.parse(s).hosts||[]).length))}catch(e){process.stdout.write("0")}})')
if [ "$RCOUNT" -gt 0 ]; then echo "OK smoke-unlock-hosts count=$RCOUNT"; else echo "ERROR smoke-unlock-hosts-empty"; exit 20; fi
if [ "$COMPLIANCE_PROXY_ALLOWED" != "1" ]; then
  BLOCKED_CODE=$(curl -sS -o /tmp/compliance-user-create.json \
    -w '%{http_code}' --max-time 15 -X POST "$API_URL/api/users" \
    -H "authorization: Bearer $TOK" \
    -H 'content-type: application/json' \
    -d '{"username":"__compliance_block_probe__","durationDays":1}' || true)
  if [ "$BLOCKED_CODE" != "403" ] \
    || ! grep -q 'documented Cloudflare authorization' /tmp/compliance-user-create.json; then
    echo "ERROR smoke-compliance-provisioning-block http=$BLOCKED_CODE"
    exit 21
  fi
  echo "OK smoke-compliance-provisioning-block"
  RELEASE_VERIFIED=1
  echo "DONE url=$API_URL"
  exit 0
fi
ORPH=$(curl -fsS --max-time 15 "$API_URL/api/users" -H "authorization: Bearer $TOK" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const u=JSON.parse(s).users||[];process.stdout.write(u.filter(x=>x.username==="__smoke__").map(x=>x.id).join(" "))}catch(e){}})')
for id in $ORPH; do curl -fsS --max-time 15 -X DELETE "$API_URL/api/users/$id" -H "authorization: Bearer $TOK" >/dev/null; done
[ -n "$ORPH" ] && echo "OK smoke-cleaned-orphans" || true
CU=$(curl -fsS --max-time 15 -X POST "$API_URL/api/users" -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d '{"username":"__smoke__","durationDays":1,"trafficLimitBytes":1048576}')
SUID=$(printf '%s' "$CU" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).user.id||"")}catch(e){process.stdout.write("")}})')
SUB=$(printf '%s' "$CU" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).subUrl||"")}catch(e){process.stdout.write("")}})')
SUUID=$(printf '%s' "$CU" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).credential.uuid||"")}catch(e){process.stdout.write("")}})')
if [ -n "$SUID" ] && [ -n "$SUUID" ] && [ -n "$SUB" ]; then echo "OK smoke-create-user(D1-write)"; else echo "ERROR smoke-create-user"; exit 21; fi
echo "::add-mask::$SUID"
echo "::add-mask::$SUUID"
echo "::add-mask::$SUB"

echo "STEP smoke-node-enrollment"
SMOKE_ACCOUNT_ID="00000000000000000000000000000000"
SMOKE_HOST="smoke-node.example.com"
SMOKE_PATH="/ws/control-smoke"
curl -fsS --max-time 15 -X DELETE "$API_URL/api/nodes/smoke-node" \
  -H "authorization: Bearer $TOK" >/dev/null 2>&1 || true
STALE_ENROLLMENTS=$(curl -fsS --max-time 15 "$API_URL/api/node-enrollments" \
  -H "authorization: Bearer $TOK" \
  | jq -r '.enrollments[] | select(.nodeId=="smoke-node") | .id')
for enrollment_id in $STALE_ENROLLMENTS; do
  curl -fsS --max-time 15 -X DELETE \
    "$API_URL/api/node-enrollments/$enrollment_id" \
    -H "authorization: Bearer $TOK" >/dev/null 2>&1 || true
done
SMOKE_ENROLL=$(curl -fsS --max-time 20 -X POST \
  "$API_URL/api/node-enrollments" \
  -H "authorization: Bearer $TOK" \
  -H 'content-type: application/json' \
  -d "$(jq -nc \
    --arg nodeId "smoke-node" \
    --arg accountAlias "smoke" \
    --arg accountId "$SMOKE_ACCOUNT_ID" \
    --arg hostname "$SMOKE_HOST" \
    --arg transportPath "$SMOKE_PATH" \
    '{nodeId:$nodeId,accountAlias:$accountAlias,accountId:$accountId,
      hostname:$hostname,region:"test",transportPath:$transportPath}')")
SMOKE_ENROLL_TOKEN=$(printf '%s' "$SMOKE_ENROLL" | jq -er '.token')
echo "::add-mask::$SMOKE_ENROLL_TOKEN"
SMOKE_EXCHANGE=$(curl -fsS --max-time 20 -X POST \
  "$API_URL/api/node-enrollments/exchange" \
  -H 'content-type: application/json' \
  -d "$(jq -nc \
    --arg token "$SMOKE_ENROLL_TOKEN" \
    --arg nodeId "smoke-node" \
    --arg accountId "$SMOKE_ACCOUNT_ID" \
    '{token:$token,nodeId:$nodeId,accountId:$accountId}')")
SMOKE_NODE_SECRET=$(printf '%s' "$SMOKE_EXCHANGE" | jq -er '.nodeSecret')
echo "::add-mask::$SMOKE_NODE_SECRET"
SMOKE_REGISTER_BODY=$(jq -nc \
  --arg nodeId "smoke-node" \
  --arg accountAlias "smoke" \
  --arg hostname "$SMOKE_HOST" \
  --arg transportPath "$SMOKE_PATH" \
  '{nodeId:$nodeId,accountAlias:$accountAlias,hostname:$hostname,
    region:"test",transportPath:$transportPath,capabilities:["smoke"]}')
SMOKE_REGISTER_TS=$(date +%s)000
SMOKE_REGISTER_SIG=$(printf 'opus8-hmac-v2\n%s\n%s\n%s\n%s\n%s' \
  "$SMOKE_REGISTER_TS" "smoke-node" "POST" "/api/nodes/register" \
  "$SMOKE_REGISTER_BODY" \
  | openssl dgst -sha256 -hmac "$SMOKE_NODE_SECRET" -r | cut -d' ' -f1)
SMOKE_REGISTER=$(curl -fsS --max-time 20 -X POST "$API_URL/api/nodes/register" \
  -H "x-opus8-ts: $SMOKE_REGISTER_TS" \
  -H "x-opus8-node: smoke-node" \
  -H "x-opus8-sign-v2: $SMOKE_REGISTER_SIG" \
  -H 'content-type: application/json' --data "$SMOKE_REGISTER_BODY")
if printf '%s' "$SMOKE_REGISTER" | jq -e \
  '.ok == true and .authMode == "isolated"' >/dev/null; then
  echo "OK smoke-node-isolated-enrollment"
else
  echo "ERROR smoke-node-enrollment"; exit 22
fi

signed_node_post() {
  local path="$1" body="$2" output="$3" ts sig
  ts=$(date +%s)000
  sig=$(printf 'opus8-hmac-v2\n%s\n%s\n%s\n%s\n%s' \
    "$ts" "smoke-node" "POST" "$path" "$body" \
    | openssl dgst -sha256 -hmac "$SMOKE_NODE_SECRET" -r | cut -d' ' -f1)
  curl -fsS --max-time 20 -X POST "$API_URL$path" \
    -H "x-opus8-ts: $ts" \
    -H "x-opus8-node: smoke-node" \
    -H "x-opus8-sign-v2: $sig" \
    -H 'content-type: application/json' \
    --data "$body" > "$output"
}

echo "STEP hmac-v2-regression"
HMAC_BODY='{"nodeId":"smoke-node","health":"healthy"}'
HMAC_TS=$(date +%s)000
HMAC_SIG=$(printf 'opus8-hmac-v2\n%s\n%s\n%s\n%s\n%s' \
  "$HMAC_TS" "smoke-node" "POST" "/api/nodes/heartbeat" "$HMAC_BODY" \
  | openssl dgst -sha256 -hmac "$SMOKE_NODE_SECRET" -r | cut -d' ' -f1)
HMAC_VALID_CODE=$(curl -sS -o /tmp/hmac-valid.json -w '%{http_code}' \
  --max-time 20 -X POST "$API_URL/api/nodes/heartbeat" \
  -H "x-opus8-ts: $HMAC_TS" \
  -H "x-opus8-node: smoke-node" \
  -H "x-opus8-sign-v2: $HMAC_SIG" \
  -H 'content-type: application/json' --data "$HMAC_BODY" || true)
HMAC_ROOT_SIG=$(printf 'opus8-hmac-v2\n%s\n%s\n%s\n%s\n%s' \
  "$HMAC_TS" "smoke-node" "POST" "/api/nodes/heartbeat" "$HMAC_BODY" \
  | openssl dgst -sha256 -hmac "$NODE_HMAC_SECRET" -r | cut -d' ' -f1)
HMAC_ROOT_CODE=$(curl -sS -o /tmp/hmac-root.json -w '%{http_code}' \
  --max-time 20 -X POST "$API_URL/api/nodes/heartbeat" \
  -H "x-opus8-ts: $HMAC_TS" \
  -H "x-opus8-node: smoke-node" \
  -H "x-opus8-sign-v2: $HMAC_ROOT_SIG" \
  -H 'content-type: application/json' --data "$HMAC_BODY" || true)
HMAC_REPLAY_CODE=$(curl -sS -o /tmp/hmac-replay.json -w '%{http_code}' \
  --max-time 20 -X POST "$API_URL/api/nodes/usage" \
  -H "x-opus8-ts: $HMAC_TS" \
  -H "x-opus8-node: smoke-node" \
  -H "x-opus8-sign-v2: $HMAC_SIG" \
  -H 'content-type: application/json' --data "$HMAC_BODY" || true)
HMAC_ID_BODY='{"nodeId":"forged-smoke-node","health":"healthy"}'
HMAC_ID_SIG=$(printf 'opus8-hmac-v2\n%s\n%s\n%s\n%s\n%s' \
  "$HMAC_TS" "smoke-node" "POST" "/api/nodes/heartbeat" "$HMAC_ID_BODY" \
  | openssl dgst -sha256 -hmac "$SMOKE_NODE_SECRET" -r | cut -d' ' -f1)
HMAC_ID_CODE=$(curl -sS -o /tmp/hmac-identity.json -w '%{http_code}' \
  --max-time 20 -X POST "$API_URL/api/nodes/heartbeat" \
  -H "x-opus8-ts: $HMAC_TS" \
  -H "x-opus8-node: smoke-node" \
  -H "x-opus8-sign-v2: $HMAC_ID_SIG" \
  -H 'content-type: application/json' --data "$HMAC_ID_BODY" || true)
if [ "$HMAC_VALID_CODE" != "200" ] \
  || [ "$HMAC_ROOT_CODE" != "401" ] \
  || [ "$HMAC_REPLAY_CODE" != "401" ] \
  || [ "$HMAC_ID_CODE" != "401" ]; then
  echo "ERROR hmac-v2-binding valid=$HMAC_VALID_CODE root=$HMAC_ROOT_CODE cross_path=$HMAC_REPLAY_CODE identity=$HMAC_ID_CODE"
  exit 22
fi
echo "OK hmac-v2-method-path-body-identity-bound"

for suffix in a b c; do
  ADMISSION_BODY=$(SUID="$SUID" SUUID="$SUUID" SUFFIX="$suffix" node -e 'process.stdout.write(JSON.stringify({nodeId:"smoke-node",userId:process.env.SUID,uuid:process.env.SUUID,leaseId:"smoke-lease-"+process.env.SUFFIX,ipHash:"smoke-ip-"+process.env.SUFFIX}))')
  signed_node_post "/api/nodes/admission" "$ADMISSION_BODY" "/tmp/admission-$suffix.json"
done
if node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync("/tmp/admission-a.json"));const b=JSON.parse(fs.readFileSync("/tmp/admission-b.json"));const c=JSON.parse(fs.readFileSync("/tmp/admission-c.json"));process.exit(a.allowed&&b.allowed&&!c.allowed&&c.reason==="active_ip_limit_exceeded"?0:1)'; then
  echo "OK smoke-active-ip-limit"
else
  echo "ERROR smoke-active-ip-limit"; exit 22
fi

BUCKET=$(( $(date +%s) / 3600 * 3600 * 1000 ))
USAGE_BODY=$(SUID="$SUID" SUUID="$SUUID" BUCKET="$BUCKET" node -e 'process.stdout.write(JSON.stringify({nodeId:"smoke-node",events:[{id:"smoke-node:usage-event",userId:process.env.SUID,uuid:process.env.SUUID,connections:1,bytesUp:111,bytesDown:222,tsBucket:Number(process.env.BUCKET)}]}))')
signed_node_post "/api/nodes/usage" "$USAGE_BODY" /tmp/usage-1.json
signed_node_post "/api/nodes/usage" "$USAGE_BODY" /tmp/usage-2.json
USERS_AFTER=$(curl -fsS --max-time 15 "$API_URL/api/users" -H "authorization: Bearer $TOK")
if printf '%s' "$USERS_AFTER" | SUID="$SUID" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const u=(JSON.parse(s).users||[]).find(x=>x.id===process.env.SUID);process.exit(u&&u.bytes_up===111&&u.bytes_down===222&&u.connections===1?0:1)})'; then
  echo "OK smoke-idempotent-usage"
else
  echo "ERROR smoke-idempotent-usage"; exit 23
fi

OVERVIEW=$(curl -fsS --max-time 20 "$API_URL/api/operations/overview" -H "authorization: Bearer $TOK")
if printf '%s' "$OVERVIEW" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);process.exit(x.summary&&x.summary.totalUsers>=1&&Array.isArray(x.series)&&x.series.length===24&&Array.isArray(x.topUsers)&&Array.isArray(x.alerts)&&Array.isArray(x.alertIncidents)&&x.alertStorage?.backend==="d1"&&x.alertStorage?.kvWrites===0?0:1)})'; then
  echo "OK smoke-operations-overview"
else
  echo "ERROR smoke-operations-overview"; exit 24
fi
ALERT_HISTORY=$(curl -fsS --max-time 20 "$API_URL/api/operations/alerts?status=all&limit=20" -H "authorization: Bearer $TOK")
if printf '%s' "$ALERT_HISTORY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);process.exit(x.backend==="d1"&&x.kvWrites===0&&Array.isArray(x.incidents)?0:1)})'; then
  echo "OK smoke-alert-history-d1-kv-writes=0"
else
  echo "ERROR smoke-alert-history"; exit 24
fi

NODE_HEALTH=""
for n in $(seq 1 12); do
  if NODE_HEALTH=$(curl -fsS --max-time 20 "$API_URL/api/operations/node-health" -H "authorization: Bearer $TOK" 2>/dev/null); then
    break
  fi
  sleep 5
done
if printf '%s' "$NODE_HEALTH" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);process.exit(x.thresholds?.failure===3&&x.thresholds?.recovery===2&&x.summary&&Array.isArray(x.nodes)&&Array.isArray(x.events)?0:1)})'; then
  echo "OK smoke-node-health-overview"
else
  echo "ERROR smoke-node-health-overview"; exit 24
fi

ACTIVITY=$(curl -fsS --max-time 20 "$API_URL/api/users/$SUID/activity" -H "authorization: Bearer $TOK")
if printf '%s' "$ACTIVITY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);process.exit(x.user&&Array.isArray(x.activeLeases)&&Array.isArray(x.recentFingerprints)&&Array.isArray(x.usageByNode)&&x.usageByNode.some(y=>y.nodeId==="smoke-node"&&y.bytesUp===111&&y.bytesDown===222)?0:1)})'; then
  echo "OK smoke-user-activity"
else
  echo "ERROR smoke-user-activity"; exit 25
fi

if curl -fsS -D /tmp/sub.headers --max-time 20 "$SUB" -o /tmp/sub-base64.txt \
  && curl -fsS -D /tmp/sub-xray.headers --max-time 20 "$SUB?format=xray" -o /tmp/sub-xray.json \
  && curl -fsS -D /tmp/sub-mihomo.headers --max-time 20 "$SUB?format=mihomo" -o /tmp/sub-mihomo.yaml \
  && curl -fsS -D /tmp/sub-singbox.headers --max-time 20 "$SUB?format=singbox" -o /tmp/sub-singbox.json; then
  echo "OK smoke-subscription-formats"
else
  echo "ERROR smoke-subscription-formats"; exit 22
fi
SUBBODY=$(cat /tmp/sub-base64.txt)
if grep -qi '^cache-control:.*private.*no-store' /tmp/sub.headers \
  && grep -qi '^x-opus8-subscription-protection:[[:space:]]*device-token-v1' /tmp/sub.headers; then
  echo "OK smoke-subscription-rate-limit-binding"
else
  echo "ERROR smoke-subscription-protection-headers"; exit 24
fi
if grep -qiE '^subscription-userinfo:.*upload=111;.*download=222;' /tmp/sub.headers; then
  echo "OK smoke-subscription-usage"
else
  echo "ERROR smoke-subscription-usage"; exit 24
fi
if printf '%s' "$SUBBODY" | base64 -d 2>/dev/null | grep -q 'vless://'; then echo "OK smoke-sub-has-node"; else echo "ERROR smoke-sub-no-node"; exit 23; fi
if node ../../infra/scripts/prepare-client-configs.mjs \
  --base64 /tmp/sub-base64.txt \
  --xray /tmp/sub-xray.json \
  --mihomo /tmp/sub-mihomo.yaml \
  --singbox /tmp/sub-singbox.json \
  --output-dir /tmp/subscription-config-smoke >/tmp/subscription-config-smoke.log 2>&1; then
  echo "OK smoke-subscription-format-equivalence"
else
  echo "ERROR smoke-subscription-format-equivalence"
  tail -n 8 /tmp/subscription-config-smoke.log
  exit 23
fi
if curl -fsS -D /tmp/sub-clash-alias.headers --max-time 20 \
  "$SUB?format=clash" -o /tmp/sub-clash-alias.yaml \
  && grep -qi '^deprecation:[[:space:]]*true' /tmp/sub-clash-alias.headers \
  && grep -qi '^x-opus8-subscription-format:[[:space:]]*mihomo' /tmp/sub-clash-alias.headers \
  && cmp -s /tmp/sub-mihomo.yaml /tmp/sub-clash-alias.yaml; then
  echo "OK smoke-clash-deprecated-alias"
else
  echo "ERROR smoke-clash-deprecated-alias"; exit 23
fi
printf '%s' "$SUBBODY" > /tmp/sub.body
curl -fsS --max-time 20 "$API_URL/api/optimized-ips" \
  -H "authorization: Bearer $TOK" > /tmp/optimized-ips.json
if VERIFIED_IP_COUNT=$(node <<'NODE'
const fs = require("fs");
const subscription = Buffer.from(
  fs.readFileSync("/tmp/sub.body", "utf8"),
  "base64",
).toString("utf8");
const response = JSON.parse(
  fs.readFileSync("/tmp/optimized-ips.json", "utf8"),
);
const safe = new Set();
for (const node of Object.values(response.pool?.nodes || {})) {
  for (const ip of node.ips || []) safe.add(`${ip}|${node.hostname}`);
}
let ipCount = 0;
for (const line of subscription.split(/\r?\n/).filter(Boolean)) {
  const url = new URL(line);
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)) continue;
  ipCount += 1;
  const sni = url.searchParams.get("sni") || "";
  const host = url.searchParams.get("host") || "";
  if (host !== sni || !safe.has(`${url.hostname}|${sni}`)) {
    process.exit(1);
  }
}
process.stdout.write(String(ipCount));
NODE
); then
  if [ "$VERIFIED_IP_COUNT" -gt 0 ]; then
    echo "OK smoke-sub-optimized-ip-safe count=$VERIFIED_IP_COUNT"
  else
    echo "OK smoke-sub-hostname-only"
  fi
else
  echo "ERROR smoke-sub-unverified-ip-or-host-mismatch"; exit 24
fi
if curl -fsS --max-time 15 -X DELETE "$API_URL/api/users/$SUID" -H "authorization: Bearer $TOK" | grep -q '"ok":true'; then echo "OK smoke-user-cleanup"; else echo "ERROR smoke-user-cleanup"; exit 25; fi
if curl -fsS --max-time 15 -X DELETE "$API_URL/api/nodes/smoke-node" -H "authorization: Bearer $TOK" | grep -q '"ok":true'; then echo "OK smoke-node-cleanup"; else echo "ERROR smoke-node-cleanup"; exit 25; fi

RELEASE_VERIFIED=1
echo "DONE url=$API_URL"
