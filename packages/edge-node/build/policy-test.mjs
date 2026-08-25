import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const prelude = readFileSync(join(here, "opus8-prelude.js"), "utf8");
const tests = `(async () => {
const request = {};
function gatewayRequest(path, { method = "GET", upgrade = "" } = {}) {
  return {
    url: "https://node.example" + path,
    method,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "upgrade" ? upgrade : null;
      },
    },
  };
}

const rootResponse = OPUS8_handleEdgeGateway(gatewayRequest("/"), {});
if (
  rootResponse.status !== 200 ||
  !rootResponse.headers.get("content-security-policy") ||
  !rootResponse.headers.get("x-content-type-options") ||
  !(await rootResponse.text()).includes("Service available")
) {
  throw new Error("ordinary root requests must receive the local hardened status page");
}
const stampedResponse = OPUS8_handleEdgeGateway(
  gatewayRequest("/login"),
  { OPUS8_BUILD_ID: "test-build-id" },
);
if (stampedResponse.headers.get("x-opus8-build-id") !== "test-build-id") {
  throw new Error("gateway responses must identify the active edge build");
}
const headResponse = OPUS8_handleEdgeGateway(gatewayRequest("/", { method: "HEAD" }), {});
if (headResponse.status !== 200 || (await headResponse.text()) !== "") {
  throw new Error("HEAD status requests must not include a response body");
}
for (const path of [
  "/login",
  "/admin",
  "/admin/config.json",
  "/admin/sub-links",
  "/sub",
  "/version",
  "/locations",
]) {
  for (const method of ["GET", "POST"]) {
    const response = OPUS8_handleEdgeGateway(gatewayRequest(path, { method }), {});
    if (
      response.status !== 404 ||
      response.headers.get("cache-control") !== "no-store" ||
      response.headers.has("set-cookie")
    ) {
      throw new Error("legacy route must fail closed: " + method + " " + path);
    }
  }
}
if (OPUS8_handleEdgeGateway(gatewayRequest("/", { upgrade: "WebSocket" }), {}) !== null) {
  throw new Error("the default WebSocket transport path must reach the transport core");
}
if (OPUS8_handleEdgeGateway(gatewayRequest("/", { method: "POST" }), {}) !== null) {
  throw new Error("the default stream transport path must reach the transport core");
}
if (
  OPUS8_handleEdgeGateway(gatewayRequest("/admin", { upgrade: "websocket" }), {}).status !== 404
) {
  throw new Error("WebSocket upgrade must not bypass exact transport-path matching");
}
const customTransport = { OPUS8_TRANSPORT_PATH: "/v1/stream" };
if (
  OPUS8_handleEdgeGateway(
    gatewayRequest("/v1/stream?ed=2560", { upgrade: "websocket" }),
    customTransport,
  ) !== null ||
  OPUS8_handleEdgeGateway(
    gatewayRequest("/v1/stream", { method: "POST" }),
    customTransport,
  ) !== null ||
  OPUS8_handleEdgeGateway(
    gatewayRequest("/", { upgrade: "websocket" }),
    customTransport,
  ).status !== 404
) {
  throw new Error("custom transport path must be matched exactly");
}
const migrationTransport = {
  OPUS8_TRANSPORT_PATH: "/ws/new-path",
  OPUS8_TRANSPORT_LEGACY_PATH: "/",
  OPUS8_TRANSPORT_LEGACY_UNTIL: String(Date.now() + 60_000),
};
if (
  OPUS8_handleEdgeGateway(
    gatewayRequest("/ws/new-path?ed=2560", { upgrade: "websocket" }),
    migrationTransport,
  ) !== null ||
  OPUS8_handleEdgeGateway(
    gatewayRequest("/?ed=2560", { upgrade: "websocket" }),
    migrationTransport,
  ) !== null
) {
  throw new Error("canary grace must accept both the primary and legacy path");
}
if (
  OPUS8_handleEdgeGateway(
    gatewayRequest("/ws/previous-path?ed=2560", { upgrade: "websocket" }),
    {
      ...migrationTransport,
      OPUS8_TRANSPORT_LEGACY_PATH: "/ws/previous-path",
    },
  ) !== null
) {
  throw new Error("path rotation must preserve the actual previous custom path");
}
if (
  OPUS8_handleEdgeGateway(
    gatewayRequest("/", { upgrade: "websocket" }),
    {
      ...migrationTransport,
      OPUS8_TRANSPORT_LEGACY_UNTIL: String(Date.now() - 1),
    },
  ).status !== 404
) {
  throw new Error("expired legacy transport path must fail closed");
}
if (
  OPUS8_handleEdgeGateway(
    gatewayRequest("/__opus8/policy/status", { upgrade: "websocket" }),
    { OPUS8_TRANSPORT_PATH: "/__opus8/policy/status" },
  ).status !== 404
) {
  throw new Error("reserved control paths must never become a data channel");
}
for (const invalidPath of [
  "/admin",
  "/sub/user",
  "/ws//double",
  "/ws/../admin",
  "/ws/path?ed=2560",
]) {
  if (
    OPUS8_handleEdgeGateway(
      gatewayRequest(invalidPath, { upgrade: "websocket" }),
      { OPUS8_TRANSPORT_PATH: invalidPath },
    ).status !== 404
  ) {
    throw new Error("invalid transport configuration must fail closed: " + invalidPath);
  }
}
if (
  OPUS8_handleEdgeGateway(gatewayRequest("/__opus8/not-a-route"), {}).status !== 404
) {
  throw new Error("unknown control paths must fail closed");
}

const unlocked = await OPUS8_normalizeState({
  uuids: ["user-a"],
  unlockUuids: ["user-a"],
  accessPolicies: [{
    userId: "account-a", uuid: "user-a", deviceLimit: 2,
    ipHashKey: "user:account-a", ipLimit24h: 5,
    trafficLimitBytes: 1073741824, usedBytes: 1024, meteringEnabled: true,
  }],
  unlockHosts: ["openai.com", "claude.ai"],
  socks5Enabled: true,
  landings: [
    {
      id: "primary", hostname: "primary.example", port: 1080,
      username: "user", password: "pass", matchHosts: ["openai.com"], priority: 10,
    },
    {
      id: "default", hostname: "default.example", port: 1080,
      username: "user", password: "pass", matchHosts: [], priority: 20,
    },
  ],
}, "local-admin", true);
OPUS8_setRequestPolicy(request, unlocked);
if (unlocked.accessPolicies["user-a"]?.deviceLimit !== 2) {
  throw new Error("access policy must be indexed by UUID");
}
const presentedUuids = ["local-admin", "user-a", "user-b"];
Object.defineProperty(presentedUuids, "OPUS8_authenticated", {
  value: "user-a", writable: true, configurable: true,
});
if (OPUS8_decideLanding(request, presentedUuids, "api.openai.com") !== true) {
  throw new Error("unlocked subdomain must use landing");
}
if (OPUS8_decideLanding(request, "user-a", "evilopenai.com") !== false) {
  throw new Error("domain suffix matching must respect label boundaries");
}
if (OPUS8_decideLanding(request, "user-a", "example.com") !== false) {
  throw new Error("unlisted domain must use direct egress");
}
if (OPUS8_canUseLanding(request, presentedUuids) !== true) {
  throw new Error("unlocked user must be allowed to use landing as direct fallback");
}
const openaiCandidates = OPUS8_landingCandidates(request, presentedUuids, "api.openai.com");
if (openaiCandidates.map((x) => x.id).join(",") !== "primary,default") {
  throw new Error("domain-specific and default landings must form an ordered failover pool");
}
const directFallback = OPUS8_landingCandidates(request, presentedUuids, "example.com");
if (directFallback.map((x) => x.id).join(",") !== "default") {
  throw new Error("unlisted domains may only use default landings as fallback");
}
if (!OPUS8_hasLandingCandidates(request, presentedUuids, "example.com")) {
  throw new Error("default landing must be available as direct failure fallback");
}
const attempts = [];
const connected = await OPUS8_connectViaLandings(
  request, presentedUuids, "api.openai.com", 443, null, null,
  async (_host, _port, _data, _tcp, landing) => {
    attempts.push(landing.id);
    if (landing.id === "primary") throw new Error("primary down");
    return "connected";
  },
  null,
);
if (connected !== "connected" || attempts.join(",") !== "primary,default") {
  throw new Error("landing failover order is incorrect");
}
presentedUuids.OPUS8_authenticated = "user-b";
if (OPUS8_decideLanding(request, presentedUuids, "openai.com") !== false) {
  throw new Error("locked user must not use landing");
}
if (OPUS8_canUseLanding(request, presentedUuids) !== false) {
  throw new Error("locked user must not use landing as fallback");
}
presentedUuids.OPUS8_authenticated = "user-a";
const streamRequest = {};
OPUS8_setRequestPolicy(streamRequest, unlocked);
const streamRuntime = OPUS8_bindUsageStream(
  streamRequest, { NODE_ID: "test" }, {}, presentedUuids, "xhttp",
);
streamRuntime.meteringEnabled = true;
streamRuntime.lastAdmission = Date.now();
const bridge = {
  readyState: 1,
  sent: [],
  send(value) { this.sent.push(value); },
  close() { this.readyState = 3; },
};
OPUS8_attachUsageBridge(streamRequest, bridge);
OPUS8_noteUplink(streamRequest, new Uint8Array(11));
OPUS8_noteDownlink(bridge, new Uint8Array(13));
if (
  streamRuntime.transport !== "xhttp" ||
  streamRuntime.bytesUp !== 11 ||
  streamRuntime.bytesDown !== 13
) {
  throw new Error("stream transport byte accounting is incorrect");
}
streamRuntime.usedBytesAtStart = 0;
streamRuntime.trafficLimitBytes = 30 * 1024 * 1024 * 1024;
streamRuntime.sessionBytes = 0;
if (
  OPUS8_usageFlushTargetBytes(streamRuntime) !== 8 * 1024 * 1024
  || OPUS8_usageFlushIntervalMs(streamRuntime) !== 120_000
) {
  throw new Error("usage aggregation must use a large batch far from quota");
}
streamRuntime.usedBytesAtStart = streamRuntime.trafficLimitBytes - 4 * 1024 * 1024;
if (
  OPUS8_usageFlushTargetBytes(streamRuntime) !== 256 * 1024
  || OPUS8_usageFlushIntervalMs(streamRuntime) !== 15_000
) {
  throw new Error("usage aggregation must tighten near quota");
}

const quotaRequest = {};
OPUS8_setRequestPolicy(quotaRequest, unlocked);
const quotaRuntime = OPUS8_bindUsageStream(
  quotaRequest, { NODE_ID: "test" }, {}, presentedUuids, "xhttp",
);
const quotaBridge = {
  readyState: 1,
  closeCode: 0,
  close(code) { this.readyState = 3; this.closeCode = code; },
};
OPUS8_attachUsageBridge(quotaRequest, quotaBridge);
quotaRuntime.admitted = true;
quotaRuntime.meteringEnabled = true;
quotaRuntime.usedBytesAtStart = 100;
quotaRuntime.trafficLimitBytes = 150;
quotaRuntime.lastAdmission = Date.now();
OPUS8_noteUplink(quotaRequest, new Uint8Array(49));
if (quotaBridge.readyState !== 1) {
  throw new Error("hard quota must not close before the exact byte limit");
}
OPUS8_noteUplink(quotaRequest, new Uint8Array(1));
if (quotaBridge.readyState !== 3 || quotaBridge.closeCode !== 1008) {
  throw new Error("adaptive aggregation must preserve exact local quota enforcement");
}
quotaRuntime.usedBytesAtStart = 100;
quotaRuntime.sessionBytes = 50;
quotaRuntime.acknowledgedSessionBytes = 50;
OPUS8_refreshQuotaBase(quotaRuntime, 150);
if (quotaRuntime.usedBytesAtStart !== 100) {
  throw new Error("admission refresh must not count acknowledged session bytes twice");
}
OPUS8_refreshQuotaBase(quotaRuntime, 180);
if (quotaRuntime.usedBytesAtStart !== 130) {
  throw new Error("admission refresh must include usage from concurrent sessions");
}
const unlimitedRequest = {};
OPUS8_setRequestPolicy(unlimitedRequest, await OPUS8_normalizeState({
  uuids: ["unlimited-user"],
  unlockUuids: [],
  accessPolicies: [{
    userId: "account-unlimited", uuid: "unlimited-user",
    ipHashKey: "user:account-unlimited", deviceLimit: 2, ipLimit24h: 5,
    trafficLimitBytes: 0, usedBytes: 0, meteringEnabled: false,
  }],
}, "local-admin", true));
const unlimitedUuid = ["unlimited-user"];
Object.defineProperty(unlimitedUuid, "OPUS8_authenticated", {
  value: "unlimited-user", configurable: true,
});
const unlimitedRuntime = OPUS8_bindUsageStream(
  unlimitedRequest, { NODE_ID: "test" }, {}, unlimitedUuid, "xhttp",
);
unlimitedRuntime.admitted = true;
unlimitedRuntime.meteringEnabled = false;
OPUS8_noteUplink(unlimitedRequest, new Uint8Array(1024));
if (
  unlimitedRuntime.bytesUp !== 0
  || unlimitedRuntime.queuedEvents.length !== 0
) {
  throw new Error("unlimited users must bypass byte accounting and usage events");
}
bridge.close();
if (!streamRuntime.closed || bridge.readyState !== 3) {
  throw new Error("stream transport must flush and close with its bridge");
}
const oldRequest = {};
OPUS8_setRequestPolicy(oldRequest, await OPUS8_normalizeState({
  uuids: ["legacy-user"],
  unlockHosts: [],
  socks5Enabled: true,
}, "local-admin", true));
if (OPUS8_decideLanding(oldRequest, "legacy-user", "openai.com") !== null) {
  throw new Error("old control-plane response must preserve vendor fallback");
}

const kvValues = new Map();
const kv = {
  async get(key) { return kvValues.get(key) ?? null; },
  async put(key, value) { kvValues.set(key, String(value)); },
  async delete(key) { kvValues.delete(key); },
};
const controlEnv = {
  KV: kv,
  NODE_ID: "test-node",
  NODE_HMAC_SECRET: "test-secret",
  CONTROL_PLANE_URL: "https://control.example",
  OPUS8_BUILD_ID: "test-build",
};
const liveStateWithFailedCacheWrite = await OPUS8_getActiveState({
  ...controlEnv,
  KV: {
    async get() { return null; },
    async put() { throw new Error("simulated KV write failure"); },
  },
}, "local-admin", {});
if (!liveStateWithFailedCacheWrite.uuids.includes("status-user")) {
  throw new Error("a KV write failure must not discard a valid live policy");
}
const buildResponse = await OPUS8_handleControlRequest(new Request(
  "https://node.example/__opus8/build",
), controlEnv);
const build = await buildResponse.json();
if (buildResponse.status !== 200 || build.buildId !== "test-build") {
  throw new Error("build probe must expose the active deployment identifier");
}
await kv.put(OPUS8_policyCacheKey(controlEnv), "cached");
await kv.put("opus8:policy:v3", "legacy");
const invalidateBody = JSON.stringify({ version: 12 });
const invalidateTimestamp = String(Date.now());
const invalidateSignature = await OPUS8_hmac(
  controlEnv.NODE_HMAC_SECRET,
  OPUS8_signatureMessageV2(
    invalidateTimestamp,
    controlEnv.NODE_ID,
    "POST",
    "/__opus8/policy/invalidate",
    invalidateBody,
  ),
);
const invalidateResponse = await OPUS8_handleControlRequest(new Request(
  "https://node.example/__opus8/policy/invalidate",
  {
    method: "POST",
    headers: {
      "x-opus8-ts": invalidateTimestamp,
      "x-opus8-node": controlEnv.NODE_ID,
      "x-opus8-sign-v2": invalidateSignature,
    },
    body: invalidateBody,
  },
), controlEnv);
if (
  invalidateResponse.status !== 200 ||
  await kv.get(OPUS8_policyInvalidationKey(controlEnv)) !== "12" ||
  await kv.get(OPUS8_policyCacheKey(controlEnv)) !== null ||
  await kv.get("opus8:policy:v3") !== null
) {
  throw new Error("signed policy invalidation must advance the marker and clear caches");
}
const replayBody = JSON.stringify({ version: 10 });
const replayTimestamp = String(Date.now());
const replaySignature = await OPUS8_hmac(
  controlEnv.NODE_HMAC_SECRET,
  OPUS8_signatureMessageV2(
    replayTimestamp,
    controlEnv.NODE_ID,
    "POST",
    "/__opus8/policy/invalidate",
    replayBody,
  ),
);
const replayResponse = await OPUS8_handleControlRequest(new Request(
  "https://node.example/__opus8/policy/invalidate",
  {
    method: "POST",
    headers: {
      "x-opus8-ts": replayTimestamp,
      "x-opus8-node": controlEnv.NODE_ID,
      "x-opus8-sign-v2": replaySignature,
    },
    body: replayBody,
  },
), controlEnv);
if (
  replayResponse.status !== 200 ||
  await kv.get(OPUS8_policyInvalidationKey(controlEnv)) !== "12"
) {
  throw new Error("an older signed invalidation must not lower the policy marker");
}
await kv.put(OPUS8_policyCacheKey(controlEnv), JSON.stringify({
  raw: { version: 12, uuids: ["status-user"] },
  exp: Date.now() + 10_000,
}));
const statusTimestamp = String(Date.now());
const statusSignature = await OPUS8_hmac(
  controlEnv.NODE_HMAC_SECRET,
  OPUS8_signatureMessageV2(
    statusTimestamp,
    controlEnv.NODE_ID,
    "GET",
    "/__opus8/policy/status?uuid=status-user",
    "",
  ),
);
const statusResponse = await OPUS8_handleControlRequest(new Request(
  "https://node.example/__opus8/policy/status?uuid=status-user",
  {
    headers: {
      "x-opus8-ts": statusTimestamp,
      "x-opus8-node": controlEnv.NODE_ID,
      "x-opus8-sign-v2": statusSignature,
    },
  },
), controlEnv);
const status = await statusResponse.json();
if (
  statusResponse.status !== 200 ||
  status.cachedVersion !== 12 ||
  status.cachedContainsUuid !== true ||
  status.liveContainsUuid !== true
) {
  throw new Error("signed policy status must report cache and live control state");
}
const tamperedStatusResponse = await OPUS8_handleControlRequest(new Request(
  "https://node.example/__opus8/policy/status?uuid=another-user",
  {
    headers: {
      "x-opus8-ts": statusTimestamp,
      "x-opus8-node": controlEnv.NODE_ID,
      "x-opus8-sign-v2": statusSignature,
    },
  },
), controlEnv);
if (tamperedStatusResponse.status !== 401) {
  throw new Error("policy status query tampering must invalidate its v2 signature");
}
const legacyStatusSignature = await OPUS8_hmac(
  controlEnv.NODE_HMAC_SECRET,
  statusTimestamp + "." + controlEnv.NODE_ID + ".",
);
const legacyStatusResponse = await OPUS8_handleControlRequest(new Request(
  "https://node.example/__opus8/policy/status?uuid=status-user",
  {
    headers: {
      "x-opus8-ts": statusTimestamp,
      "x-opus8-node": controlEnv.NODE_ID,
      "x-opus8-sign": legacyStatusSignature,
    },
  },
), controlEnv);
if (legacyStatusResponse.status !== 401) {
  throw new Error("new edge control endpoints must reject legacy signatures");
}
})();`;

await runInNewContext(`${prelude}\n${tests}`, {
  console,
  crypto: globalThis.crypto,
  Request,
  Response,
  URL,
  fetch: async () => new Response(JSON.stringify({
    version: 12,
    uuids: ["status-user"],
  })),
  TextEncoder,
  TextDecoder,
  WeakMap,
  Set,
  Uint8Array,
  atob,
});
console.log("OK edge policy tests");
