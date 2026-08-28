import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

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
const { buildBase64, buildClash, buildSingbox, nodesForUser } =
  await import(moduleUrl);

function assert(value, message) {
  if (!value) throw new Error(message);
}

const user = {
  id: "user-1",
  username: "transport-test",
  uuid: "11111111-1111-4111-8111-111111111111",
  plan_id: null,
  node_group: null,
  unlock: 0,
  sub_token: "a".repeat(32),
  expire_at: null,
  enabled: 1,
  created_at: Date.now(),
};
const node = {
  id: "node-1",
  account_alias: "acc1",
  hostname: "node.example.com",
  region: "US",
  capabilities: '["vless-ws","transport-path-v1"]',
  preferred_ip: null,
  transport_path: "/ws/0123456789abcdef",
  health: "healthy",
  enabled: 1,
  last_seen: Date.now(),
  created_at: Date.now(),
};
const entries = [{ node, address: node.hostname, name: "Opus8-test" }];

const decoded = Buffer.from(buildBase64(user, entries), "base64").toString(
  "utf8",
);
const xray = new URL(decoded.trim());
assert(
  xray.searchParams.get("path") === "/ws/0123456789abcdef?ed=2560",
  "Xray URI must keep Early Data in its WebSocket path query",
);
const dynamicUuid = "22222222-2222-4222-8222-222222222222";
const dynamicDecoded = Buffer.from(
  buildBase64(user, entries, dynamicUuid),
  "base64",
).toString("utf8");
assert(
  dynamicDecoded.includes(`vless://${dynamicUuid}@`),
  "subscription rendering must support a per-device dynamic credential",
);

const clash = buildClash(user, entries);
const mihomoProxy = parseYaml(clash).proxies[0];
assert(
  mihomoProxy["ws-opts"].path === "/ws/0123456789abcdef" &&
    mihomoProxy["ws-opts"]["max-early-data"] === 2560 &&
    mihomoProxy["ws-opts"]["early-data-header-name"] === "Sec-WebSocket-Protocol",
  "Mihomo must use its explicit Early Data fields and a query-free path",
);

const singbox = JSON.parse(buildSingbox(user, entries));
const transport = singbox.outbounds.find((outbound) => outbound.type === "vless").transport;
assert(
  transport.path === "/ws/0123456789abcdef" &&
    transport.max_early_data === 2560 &&
    transport.early_data_header_name === "Sec-WebSocket-Protocol",
  "sing-box must use its explicit Early Data fields",
);

const legacyNode = { ...node, id: "legacy", transport_path: null };
const invalidNodes = [
  { ...node, id: "reserved", transport_path: "/__opus8/policy" },
  { ...node, id: "query", transport_path: "/ws/path?ed=2560" },
  { ...node, id: "traversal", transport_path: "/ws/../admin" },
];
const selected = nodesForUser(user, [legacyNode, node, ...invalidNodes]);
assert(
  selected.map((item) => item.id).join(",") === "legacy,node-1",
  "legacy root nodes must remain compatible while malformed paths are excluded",
);

console.log("OK transport path subscription tests");
