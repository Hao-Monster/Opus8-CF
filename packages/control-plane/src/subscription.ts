import {
  nodeTransportPath,
  TRANSPORT_EARLY_DATA,
  TRANSPORT_EARLY_DATA_HEADER,
  xrayWebSocketPath,
  type NodeRecord,
  type UserRecord,
  type SubFormat,
} from "@opus8-cf/shared";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import mihomoTemplateText from "../templates/mihomo.yaml";
import singboxTemplateSource from "../templates/sing-box.json";
import xrayTemplateSource from "../templates/xray.json";
import { userAssignedToNode } from "./node-assignment";

export const MAX_OPTIMIZED_IPS_PER_NODE = 8;
export const DEFAULT_TEMPLATE_VERSION = "v1";

function nodeName(node: NodeRecord): string {
  return `Opus8-${node.region || node.account_alias}-${node.id}`;
}

/** 选出分配给该用户的节点（node_group 为空=全部启用且健康）。 */
export function nodesForUser(user: UserRecord, all: NodeRecord[]): NodeRecord[] {
  const healthy = all.filter(
    (node) =>
      node.enabled === 1 &&
      node.health !== "banned" &&
      nodeTransportPath(node.transport_path) !== null,
  );
  return healthy.filter((node) =>
    userAssignedToNode(user.node_group, node.id, node.account_alias),
  );
}

export interface ResolvedSubscriptionNode {
  nodeId: string;
  node: NodeRecord;
  name: string;
  address: string;
  hostname: string;
  port: 443;
  transportPath: string;
  credentialUuid: string;
  optimized: boolean;
}

interface LegacyEntry {
  node: NodeRecord;
  address: string;
  name: string;
  credentialUuid?: string;
}

type RenderEntry = ResolvedSubscriptionNode | LegacyEntry;
export type OptimizedIpsByNode = Record<string, string[]>;

export function normalizeIpLiteral(value: string): string | null {
  const candidate = value.trim();
  const octets = candidate.split(".");
  if (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  ) {
    return octets.map((octet) => String(Number(octet))).join(".");
  }
  if (!candidate.includes(":")) return null;
  try {
    const parsed = new URL(`https://[${candidate}]/`);
    const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
    return hostname.includes(":") ? hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function stableNodeOrder(left: NodeRecord, right: NodeRecord): number {
  return (
    left.account_alias.localeCompare(right.account_alias) ||
    left.id.localeCompare(right.id)
  );
}

/** Resolve one canonical entry set for every subscription format. */
export function resolveSubscriptionNodes(
  nodes: NodeRecord[],
  optIpsByNode: OptimizedIpsByNode = {},
  credentialUuid: string,
  maxOptimizedIpsPerNode = MAX_OPTIMIZED_IPS_PER_NODE,
): ResolvedSubscriptionNode[] {
  const safeLimit = Math.max(
    1,
    Math.min(MAX_OPTIMIZED_IPS_PER_NODE, Math.trunc(maxOptimizedIpsPerNode) || 1),
  );
  const entries: ResolvedSubscriptionNode[] = [];
  for (const node of [...nodes].sort(stableNodeOrder)) {
    const transportPath = nodeTransportPath(node.transport_path);
    if (!transportPath) continue;
    const ips = [
      ...new Set(
        (optIpsByNode[node.id] || [])
          .map((value) => normalizeIpLiteral(value))
          .filter((value): value is string => value !== null),
      ),
    ].slice(0, safeLimit);
    const addresses = ips.length > 0 ? ips : [node.hostname];
    addresses.forEach((address, index) => {
      entries.push({
        nodeId: node.id,
        node,
        name: `${nodeName(node)}-${String(index + 1).padStart(2, "0")}`,
        address,
        hostname: node.hostname,
        port: 443,
        transportPath,
        credentialUuid,
        optimized: ips.length > 0,
      });
    });
  }
  return entries;
}

function entryCredential(entry: RenderEntry, fallback: string): string {
  return "credentialUuid" in entry && entry.credentialUuid
    ? entry.credentialUuid
    : fallback;
}

function entryPath(entry: RenderEntry): string {
  if ("transportPath" in entry) return entry.transportPath;
  const path = nodeTransportPath(entry.node.transport_path);
  if (!path) throw new Error(`节点 ${entry.node.id} 的传输路径无效`);
  return path;
}

function urlAddress(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

function vlessLink(uuid: string, entry: RenderEntry): string {
  const host = entry.node.hostname;
  const path = entryPath(entry);
  const query = new URLSearchParams({
    encryption: "none",
    security: "tls",
    sni: host,
    fp: "chrome",
    type: "ws",
    host,
    path: xrayWebSocketPath(path),
  });
  return `vless://${uuid}@${urlAddress(entry.address)}:443?${query.toString()}#${encodeURIComponent(entry.name)}`;
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function buildBase64(
  user: UserRecord,
  entries: RenderEntry[],
  credentialUuid = user.uuid,
): string {
  return utf8ToBase64(
    entries
      .map((entry) => vlessLink(entryCredential(entry, credentialUuid), entry))
      .join("\n"),
  );
}

type JsonObject = Record<string, unknown>;

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

const mihomoTemplate = parseYaml(mihomoTemplateText) as JsonObject;
const singboxTemplate = singboxTemplateSource as JsonObject;
const xrayTemplate = xrayTemplateSource as JsonObject;

function objectArray(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value) || !value.every((item) => item && typeof item === "object")) {
    throw new Error(`订阅模板缺少 ${label}`);
  }
  return value as JsonObject[];
}

function replaceRuleBase(value: unknown, ruleBaseUrl: string): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && child.includes("__OPUS8_RULE_BASE__")) {
      (value as JsonObject)[key] = child.replace("__OPUS8_RULE_BASE__", ruleBaseUrl);
    } else {
      replaceRuleBase(child, ruleBaseUrl);
    }
  }
}

function mihomoProxy(entry: RenderEntry, fallbackUuid: string): JsonObject {
  return {
    name: entry.name,
    type: "vless",
    server: entry.address,
    port: 443,
    uuid: entryCredential(entry, fallbackUuid),
    network: "ws",
    tls: true,
    udp: true,
    servername: entry.node.hostname,
    "client-fingerprint": "chrome",
    "ws-opts": {
      path: entryPath(entry),
      headers: { Host: entry.node.hostname },
      "max-early-data": TRANSPORT_EARLY_DATA,
      "early-data-header-name": TRANSPORT_EARLY_DATA_HEADER,
    },
  };
}

export function buildMihomo(
  user: UserRecord,
  entries: RenderEntry[],
  credentialUuid = user.uuid,
  ruleBaseUrl = "https://sub.invalid/rules/v1",
): string {
  const config = cloneJson(mihomoTemplate);
  const names = entries.map((entry) => entry.name);
  config.proxies = entries.map((entry) => mihomoProxy(entry, credentialUuid));
  const groups = objectArray(config["proxy-groups"], "proxy-groups");
  const proxy = groups.find((group) => group.name === "PROXY");
  const auto = groups.find((group) => group.name === "Auto");
  const fallback = groups.find((group) => group.name === "Fallback");
  if (!proxy || !auto || !fallback) {
    throw new Error("Mihomo 模板缺少 PROXY、Auto 或 Fallback 代理组");
  }
  proxy.proxies = ["Auto", "Fallback", ...names, "DIRECT"];
  auto.proxies = names;
  fallback.proxies = names;
  replaceRuleBase(config, ruleBaseUrl);
  return stringifyYaml(config, { lineWidth: 0 });
}

/** One-release compatibility export for existing callers. */
export function buildClash(
  user: UserRecord,
  entries: RenderEntry[],
  credentialUuid = user.uuid,
): string {
  return buildMihomo(user, entries, credentialUuid);
}

function singboxProxy(entry: RenderEntry, fallbackUuid: string): JsonObject {
  return {
    type: "vless",
    tag: entry.name,
    server: entry.address,
    server_port: 443,
    uuid: entryCredential(entry, fallbackUuid),
    tls: {
      enabled: true,
      server_name: entry.node.hostname,
      insecure: false,
    },
    transport: {
      type: "ws",
      path: entryPath(entry),
      headers: { Host: entry.node.hostname },
      max_early_data: TRANSPORT_EARLY_DATA,
      early_data_header_name: TRANSPORT_EARLY_DATA_HEADER,
    },
  };
}

function singboxRuleSets(ruleBaseUrl: string): JsonObject[] {
  const tags = [
    "private_domain",
    "cn_domain",
    "geolocation_not_cn",
    "cn_ip",
  ];
  return tags.map((tag) => ({
    type: "remote",
    tag,
    format: "binary",
    url: `${ruleBaseUrl}/singbox/${tag}.srs`,
    download_detour: "direct",
    update_interval: "1d",
  }));
}

export function buildSingbox(
  user: UserRecord,
  entries: RenderEntry[],
  credentialUuid = user.uuid,
  ruleBaseUrl = "https://sub.invalid/rules/v1",
): string {
  const config = cloneJson(singboxTemplate);
  const names = entries.map((entry) => entry.name);
  const outbounds = objectArray(config.outbounds, "outbounds");
  const selector = outbounds.find((outbound) => outbound.tag === "PROXY");
  const auto = outbounds.find((outbound) => outbound.tag === "Auto");
  if (!selector || !auto) throw new Error("sing-box 模板缺少 PROXY 或 Auto 出站");
  selector.outbounds = ["Auto", ...names, "direct"];
  auto.outbounds = names;
  const direct = outbounds.filter((outbound) => outbound.tag === "direct");
  config.outbounds = [
    selector,
    auto,
    ...entries.map((entry) => singboxProxy(entry, credentialUuid)),
    ...direct,
  ];
  const route = config.route as JsonObject;
  if (!route || typeof route !== "object") throw new Error("sing-box 模板缺少 route");
  route.rule_set = singboxRuleSets(ruleBaseUrl);
  return `${JSON.stringify(config, null, 2)}\n`;
}

function xrayProxy(entry: RenderEntry, fallbackUuid: string): JsonObject {
  return {
    tag: "proxy",
    protocol: "vless",
    settings: {
      vnext: [
        {
          address: entry.address,
          port: 443,
          users: [
            {
              id: entryCredential(entry, fallbackUuid),
              encryption: "none",
            },
          ],
        },
      ],
    },
    streamSettings: {
      network: "ws",
      security: "tls",
      tlsSettings: {
        serverName: entry.node.hostname,
        allowInsecure: false,
        fingerprint: "chrome",
      },
      wsSettings: {
        path: xrayWebSocketPath(entryPath(entry)),
        headers: { Host: entry.node.hostname },
      },
    },
  };
}

export function buildXray(
  user: UserRecord,
  entries: RenderEntry[],
  credentialUuid = user.uuid,
): string {
  const configs = entries.map((entry) => {
    const config = cloneJson(xrayTemplate);
    config.remarks = entry.name;
    config.outbounds = [
      xrayProxy(entry, credentialUuid),
      ...objectArray(config.outbounds, "outbounds"),
    ];
    return config;
  });
  return `${JSON.stringify(configs, null, 2)}\n`;
}

export type FormatSelection =
  | { ok: true; format: SubFormat; deprecatedAlias?: "clash" }
  | { ok: false; status: 400 | 406; message: string };

export function selectSubscriptionFormat(
  userAgent: string,
  override?: string | null,
): FormatSelection {
  if (override !== null && override !== undefined && override !== "") {
    if (
      override === "base64" ||
      override === "mihomo" ||
      override === "singbox" ||
      override === "xray"
    ) {
      return { ok: true, format: override };
    }
    if (override === "clash") {
      return { ok: true, format: "mihomo", deprecatedAlias: "clash" };
    }
    return { ok: false, status: 400, message: "订阅格式不支持" };
  }

  const ua = userAgent.toLowerCase();
  if (ua.includes("sing-box") || ua.includes("singbox")) {
    return { ok: true, format: "singbox" };
  }
  if (
    ua.includes("mihomo") ||
    ua.includes("clash.meta") ||
    ua.includes("clash-verge") ||
    ua.includes("stash")
  ) {
    return { ok: true, format: "mihomo" };
  }
  if (ua.includes("clash")) {
    return { ok: true, format: "mihomo", deprecatedAlias: "clash" };
  }
  return { ok: true, format: "base64" };
}

/** Compatibility wrapper; request handling uses selectSubscriptionFormat. */
export function pickFormat(ua: string, override?: string | null): SubFormat {
  const selection = selectSubscriptionFormat(ua, override);
  return selection.ok ? selection.format : "base64";
}

export interface SubscriptionRenderOptions {
  ruleBaseUrl?: string;
  templateVersion?: string;
  maxOptimizedIpsPerNode?: number;
}

export function renderSubscription(
  format: SubFormat,
  user: UserRecord,
  nodes: NodeRecord[],
  optIpsByNode: OptimizedIpsByNode = {},
  credentialUuid = user.uuid,
  options: SubscriptionRenderOptions = {},
): {
  body: string;
  contentType: string;
  format: SubFormat;
  templateVersion: string;
  entryCount: number;
} {
  const entries = resolveSubscriptionNodes(
    nodes,
    optIpsByNode,
    credentialUuid,
    options.maxOptimizedIpsPerNode,
  );
  const ruleBaseUrl = (options.ruleBaseUrl || "https://sub.invalid/rules/v1").replace(/\/$/, "");
  const templateVersion = options.templateVersion || DEFAULT_TEMPLATE_VERSION;
  if (format === "mihomo") {
    return {
      body: buildMihomo(user, entries, credentialUuid, ruleBaseUrl),
      contentType: "text/yaml; charset=utf-8",
      format,
      templateVersion,
      entryCount: entries.length,
    };
  }
  if (format === "singbox") {
    return {
      body: buildSingbox(user, entries, credentialUuid, ruleBaseUrl),
      contentType: "application/json; charset=utf-8",
      format,
      templateVersion,
      entryCount: entries.length,
    };
  }
  if (format === "xray") {
    return {
      body: buildXray(user, entries, credentialUuid),
      contentType: "application/json; charset=utf-8",
      format,
      templateVersion,
      entryCount: entries.length,
    };
  }
  return {
    body: buildBase64(user, entries, credentialUuid),
    contentType: "text/plain; charset=utf-8",
    format,
    templateVersion,
    entryCount: entries.length,
  };
}
