import assert from "node:assert/strict";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const controlRoot = join(here, "..");
const bundled = await build({
  entryPoints: [join(controlRoot, "src", "subscription.ts")],
  alias: {
    "@opus8-cf/shared": join(controlRoot, "..", "shared", "src", "index.ts"),
  },
  bundle: true,
  format: "esm",
  platform: "neutral",
  loader: { ".yaml": "text" },
  write: false,
});
const moduleUrl =
  "data:text/javascript;base64," +
  Buffer.from(bundled.outputFiles[0].text).toString("base64");
const subscription = await import(moduleUrl);

assert.equal(
  typeof subscription.resolveSubscriptionNodes,
  "function",
  "subscription renderer must expose one shared node resolver",
);
assert.equal(
  typeof subscription.selectSubscriptionFormat,
  "function",
  "subscription renderer must expose explicit format selection",
);

const user = {
  id: "user-1",
  username: "subscription-test",
  uuid: "11111111-1111-4111-8111-111111111111",
  plan_id: null,
  node_group: null,
  unlock: 0,
  sub_token: "a".repeat(32),
  expire_at: null,
  enabled: 1,
  created_at: Date.now(),
};

function node(index) {
  return {
    id: `node-${index}`,
    account_alias: index < 3 ? "acc1" : "acc2",
    hostname: `node-${index}.example.com`,
    region: index % 2 ? "US" : "SG",
    capabilities: '["vless-ws","transport-path-v1"]',
    preferred_ip: `198.51.100.${index}`,
    transport_path: `/ws/${String(index).padStart(24, "0")}`,
    health: "healthy",
    enabled: 1,
    last_seen: Date.now(),
    created_at: Date.now(),
  };
}

const nodes = [node(4), node(2), node(1), node(3)];
const pool = Object.fromEntries(
  nodes.map((item, nodeIndex) => [
    item.id,
    Array.from(
      { length: 8 },
      (_, ipIndex) => `203.0.${nodeIndex + 1}.${ipIndex + 1}`,
    ),
  ]),
);
const credentialUuid = "22222222-2222-4222-8222-222222222222";
const resolved = subscription.resolveSubscriptionNodes(
  nodes,
  pool,
  credentialUuid,
);

assert.equal(resolved.length, 32, "four workers with eight safe IPs must render 32 nodes");
assert.equal(new Set(resolved.map((entry) => entry.name)).size, 32, "node names must be unique");
assert(resolved.every((entry) => entry.credentialUuid === credentialUuid));
assert(resolved.every((entry) => entry.optimized === true));
assert.match(resolved[0].name, /-01$/, "stable slots must start at 01");
assert.deepEqual(
  subscription.resolveSubscriptionNodes([...nodes].reverse(), pool, credentialUuid).map((entry) => entry.name),
  resolved.map((entry) => entry.name),
  "node names and slots must not depend on database row order",
);
const collidingPrefixNodes = [
  { ...node(1), id: "abcdef-node-a" },
  { ...node(2), id: "abcdef-node-b" },
];
assert.equal(
  new Set(
    subscription.resolveSubscriptionNodes(collidingPrefixNodes, {}, credentialUuid)
      .map((entry) => entry.name),
  ).size,
  2,
  "full node IDs must keep names unique when their first six characters collide",
);

const duplicatePool = {
  "node-1": ["203.0.113.8", "203.0.113.8", "203.0.113.9"],
  "node-2": ["203.0.113.8"],
};
const deduplicated = subscription.resolveSubscriptionNodes(
  [node(1), node(2), node(3)],
  duplicatePool,
  credentialUuid,
);
assert.equal(
  deduplicated.filter((entry) => entry.nodeId === "node-1").length,
  2,
  "one worker must not repeat the same IP",
);
assert.equal(
  deduplicated.filter((entry) => entry.address === "203.0.113.8").length,
  2,
  "the same independently validated IP may be reused by different workers",
);
const fallback = deduplicated.find((entry) => entry.nodeId === "node-3");
assert.equal(fallback.address, "node-3.example.com", "fallback must use the node hostname");
assert.equal(fallback.optimized, false);
assert.notEqual(fallback.address, node(3).preferred_ip, "fallback must not trust preferred_ip");

const commonOptions = {
  ruleBaseUrl: "https://sub.example.com/rules/v1",
  templateVersion: "v1",
};
const rendered = Object.fromEntries(
  ["base64", "mihomo", "singbox", "xray"].map((format) => [
    format,
    subscription.renderSubscription(
      format,
      user,
      [node(1), node(2), node(3)],
      duplicatePool,
      credentialUuid,
      commonOptions,
    ),
  ]),
);

const base64Lines = Buffer.from(rendered.base64.body, "base64")
  .toString("utf8")
  .trim()
  .split(/\r?\n/);
assert.equal(base64Lines.length, deduplicated.length);
assert(base64Lines.every((line) => line.startsWith(`vless://${credentialUuid}@`)));

assert.match(rendered.mihomo.body, /^proxies:/m);
assert.match(rendered.mihomo.body, /^  - name: PROXY$/m);
assert.match(rendered.mihomo.body, /^  - name: Auto$/m);
assert.match(rendered.mihomo.body, /^  - name: Fallback$/m);
for (const entry of deduplicated) {
  assert(rendered.mihomo.body.includes(entry.name), `Mihomo missing ${entry.name}`);
}

const singbox = JSON.parse(rendered.singbox.body);
const singboxDynamic = singbox.outbounds.filter((outbound) => outbound.type === "vless");
assert.equal(singboxDynamic.length, deduplicated.length);
assert(singbox.outbounds.some((outbound) => outbound.type === "selector" && outbound.tag === "PROXY"));
assert(singbox.outbounds.some((outbound) => outbound.type === "urltest" && outbound.tag === "Auto"));

const xray = JSON.parse(rendered.xray.body);
assert.equal(xray.length, deduplicated.length);
assert(xray.every((config) => config.outbounds[0].tag === "proxy"));
assert(xray.every((config) => config.outbounds[0].protocol === "vless"));

assert.deepEqual(subscription.selectSubscriptionFormat("mihomo/1.19", null), {
  ok: true,
  format: "mihomo",
});
assert.deepEqual(subscription.selectSubscriptionFormat("sing-box/1.13", null), {
  ok: true,
  format: "singbox",
});
assert.deepEqual(subscription.selectSubscriptionFormat("v2rayN/7", null), {
  ok: true,
  format: "base64",
});
assert.deepEqual(subscription.selectSubscriptionFormat("", "xray"), {
  ok: true,
  format: "xray",
});
assert.deepEqual(subscription.selectSubscriptionFormat("", "clash"), {
  ok: true,
  format: "mihomo",
  deprecatedAlias: "clash",
});
assert.deepEqual(subscription.selectSubscriptionFormat("", "unknown"), {
  ok: false,
  status: 400,
  message: "订阅格式不支持",
});

console.log("OK subscription renderer tests");
