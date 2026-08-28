#!/usr/bin/env node

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const requireFromControlPlane = createRequire(
  resolve(repoRoot, "packages", "control-plane", "package.json"),
);
const { parse: parseYaml, stringify: stringifyYaml } = requireFromControlPlane("yaml");

const EARLY_DATA = 2560;
const EARLY_DATA_HEADER = "Sec-WebSocket-Protocol";
const DEFAULT_PORTS = Object.freeze({
  xray: 18081,
  mihomo: 18082,
  singbox: 18083,
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function firstMihomoProxy(text) {
  const config = parseYaml(text);
  assert(config && typeof config === "object", "Mihomo 订阅不是有效对象");
  assert(Array.isArray(config.proxies) && config.proxies.length > 0, "Mihomo 订阅没有代理条目");
  const proxy = structuredClone(config.proxies[0]);
  assert(proxy["skip-cert-verify"] !== true, "Mihomo 禁止跳过证书校验");
  assert(!proxy.alpn, "Mihomo WebSocket 禁止强制 ALPN");
  return {
    config,
    nodeCount: config.proxies.length,
    name: proxy.name,
    type: proxy.type,
    server: proxy.server,
    port: Number(proxy.port),
    uuid: proxy.uuid,
    network: proxy.network,
    tls: proxy.tls === true,
    serverName: proxy.servername,
    fingerprint: proxy["client-fingerprint"],
    path: proxy["ws-opts"]?.path,
    host: proxy["ws-opts"]?.headers?.Host,
    earlyData: Number(proxy["ws-opts"]?.["max-early-data"]),
    earlyDataHeader: proxy["ws-opts"]?.["early-data-header-name"],
  };
}

function parseBase64Subscription(text) {
  const decoded = Buffer.from(text.trim(), "base64").toString("utf8");
  const links = decoded
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const link = links[0];
  assert(links.every((value) => value.startsWith("vless://")), "base64 订阅含非 VLESS 条目");
  assert(link?.startsWith("vless://"), "base64 订阅没有 VLESS 条目");
  const url = new URL(link);
  const path = url.searchParams.get("path");
  const serverName = url.searchParams.get("sni");
  const host = url.searchParams.get("host");
  assert(url.username, "Xray VLESS 条目缺少 UUID");
  assert(url.hostname, "Xray VLESS 条目缺少服务器地址");
  assert(Number(url.port || 443) === 443, "Xray VLESS 端口必须为 443");
  assert(url.searchParams.get("encryption") === "none", "Xray VLESS encryption 必须为 none");
  assert(url.searchParams.get("security") === "tls", "Xray VLESS 必须启用 TLS");
  assert(url.searchParams.get("type") === "ws", "Xray VLESS 必须使用 WebSocket");
  assert(serverName && host === serverName, "Xray VLESS 的 SNI 与 Host 必须一致");
  assert(url.searchParams.get("fp") === "chrome", "Xray VLESS 缺少稳定的 chrome 指纹值");
  assert(path?.startsWith("/"), "Xray VLESS 缺少绝对 WebSocket 路径");
  for (const key of ["allowInsecure", "insecure"]) {
    assert(
      !["1", "true"].includes((url.searchParams.get(key) || "").toLowerCase()),
      "Xray VLESS 禁止跳过证书校验",
    );
  }
  assert(!url.searchParams.has("alpn"), "Xray WebSocket 禁止强制 ALPN");
  const parsedPath = new URL(path, "https://opus8.invalid");
  assert(parsedPath.searchParams.get("ed") === String(EARLY_DATA), "Xray Early Data 参数错误");
  assert(
    [...parsedPath.searchParams.keys()].every((key) => key === "ed"),
    "Xray WebSocket 路径含未知查询参数",
  );
  return {
    nodeCount: links.length,
    address: url.hostname,
    port: 443,
    uuid: decodeURIComponent(url.username),
    serverName,
    host,
    path,
    pathName: parsedPath.pathname,
  };
}

function parseXraySubscription(text) {
  const configs = JSON.parse(text);
  assert(Array.isArray(configs) && configs.length > 0, "Xray 订阅必须是非空配置数组");
  const config = structuredClone(configs[0]);
  const outbound = config.outbounds?.find(
    (item) => item?.tag === "proxy" && item?.protocol === "vless",
  );
  assert(outbound, "Xray 配置缺少 proxy VLESS 出站");
  const target = outbound.settings?.vnext?.[0];
  const user = target?.users?.[0];
  const tls = outbound.streamSettings?.tlsSettings;
  const ws = outbound.streamSettings?.wsSettings;
  assert(target?.address && target?.port === 443, "Xray 服务器或端口无效");
  assert(user?.id && user?.encryption === "none", "Xray VLESS 用户配置无效");
  assert(outbound.streamSettings?.network === "ws", "Xray 必须使用 WebSocket");
  assert(outbound.streamSettings?.security === "tls", "Xray 必须启用 TLS");
  assert(tls?.allowInsecure === false, "Xray 禁止跳过证书校验");
  assert(tls?.serverName && ws?.headers?.Host === tls.serverName, "Xray 的 SNI 与 Host 必须一致");
  assert(!tls?.alpn, "Xray WebSocket 禁止强制 ALPN");
  const parsedPath = new URL(ws.path, "https://opus8.invalid");
  assert(parsedPath.searchParams.get("ed") === String(EARLY_DATA), "Xray Early Data 参数错误");
  return {
    config,
    nodeCount: configs.length,
    address: target.address,
    port: target.port,
    uuid: user.id,
    serverName: tls.serverName,
    host: ws.headers.Host,
    path: ws.path,
    pathName: parsedPath.pathname,
  };
}

function parseSingboxSubscription(text) {
  const parsed = JSON.parse(text);
  assert(Array.isArray(parsed.outbounds) && parsed.outbounds.length > 0, "sing-box 订阅没有 outbounds");
  const vlessOutbounds = parsed.outbounds.filter((item) => item?.type === "vless");
  const candidate = vlessOutbounds[0];
  assert(candidate, "sing-box 订阅没有 VLESS outbound");
  const outbound = structuredClone(candidate);
  assert(outbound.type === "vless", "sing-box outbound 必须为 VLESS");
  assert(outbound.server && outbound.server_port === 443, "sing-box 服务器或端口无效");
  assert(outbound.uuid, "sing-box outbound 缺少 UUID");
  assert(outbound.tls?.enabled === true, "sing-box 必须启用 TLS");
  assert(outbound.tls?.insecure === false, "sing-box 禁止跳过证书校验");
  assert(outbound.tls?.utls?.enabled !== true, "sing-box 禁止依赖 uTLS 指纹伪装");
  assert(!outbound.tls?.alpn, "sing-box WebSocket 禁止强制 ALPN");
  assert(outbound.tls?.server_name, "sing-box 缺少 TLS server_name");
  assert(outbound.transport?.type === "ws", "sing-box 必须使用 WebSocket");
  assert(outbound.transport?.path?.startsWith("/"), "sing-box WebSocket 路径无效");
  assert(
    outbound.transport?.max_early_data === EARLY_DATA,
    "sing-box Early Data 数值错误",
  );
  assert(
    outbound.transport?.early_data_header_name === EARLY_DATA_HEADER,
    "sing-box Early Data 请求头错误",
  );
  assert(
    outbound.transport?.headers?.Host === outbound.tls.server_name,
    "sing-box 的 SNI 与 Host 必须一致",
  );
  return { config: parsed, outbound, nodeCount: vlessOutbounds.length };
}

function validatePorts(ports) {
  const values = Object.values(ports);
  assert(
    values.every((port) => Number.isSafeInteger(port) && port >= 1024 && port <= 65535),
    "本地 SOCKS 端口无效",
  );
  assert(new Set(values).size === values.length, "本地 SOCKS 端口不能重复");
}

export async function prepareClientConfigs({
  base64Path,
  xrayPath,
  mihomoPath,
  singboxPath,
  outputDir,
  ports = DEFAULT_PORTS,
}) {
  validatePorts(ports);
  const [base64Text, xrayText, mihomoText, singboxText] = await Promise.all([
    readFile(base64Path, "utf8"),
    readFile(xrayPath, "utf8"),
    readFile(mihomoPath, "utf8"),
    readFile(singboxPath, "utf8"),
  ]);
  const base64Entry = parseBase64Subscription(base64Text);
  const xrayEntry = parseXraySubscription(xrayText);
  const mihomoEntry = firstMihomoProxy(mihomoText);
  const singboxParsed = parseSingboxSubscription(singboxText);
  const singboxOutbound = singboxParsed.outbound;

  assert(mihomoEntry.type === "vless", "Mihomo 代理必须为 VLESS");
  assert(mihomoEntry.network === "ws", "Mihomo 代理必须使用 WebSocket");
  assert(mihomoEntry.tls, "Mihomo 代理必须启用 TLS");
  assert(mihomoEntry.fingerprint === "chrome", "Mihomo 客户端指纹必须为 chrome");
  assert(mihomoEntry.earlyData === EARLY_DATA, "Mihomo Early Data 数值错误");
  assert(
    mihomoEntry.earlyDataHeader === EARLY_DATA_HEADER,
    "Mihomo Early Data 请求头错误",
  );
  assert(mihomoEntry.serverName === mihomoEntry.host, "Mihomo 的 SNI 与 Host 必须一致");

  const comparisons = [
    ["服务器地址", base64Entry.address, xrayEntry.address, mihomoEntry.server, singboxOutbound.server],
    ["UUID", base64Entry.uuid, xrayEntry.uuid, mihomoEntry.uuid, singboxOutbound.uuid],
    ["SNI", base64Entry.serverName, xrayEntry.serverName, mihomoEntry.serverName, singboxOutbound.tls.server_name],
    ["Host", base64Entry.host, xrayEntry.host, mihomoEntry.host, singboxOutbound.transport.headers.Host],
    ["WebSocket pathname", base64Entry.pathName, xrayEntry.pathName, mihomoEntry.path, singboxOutbound.transport.path],
  ];
  for (const [label, ...values] of comparisons) {
    assert(new Set(values).size === 1, `四种订阅的${label}不一致`);
  }
  assert(mihomoEntry.port === 443, "Mihomo 端口必须为 443");
  assert(
    new Set([
      base64Entry.nodeCount,
      xrayEntry.nodeCount,
      mihomoEntry.nodeCount,
      singboxParsed.nodeCount,
    ]).size === 1,
    "四种订阅的节点数量不一致",
  );

  const xrayConfig = structuredClone(xrayEntry.config);
  xrayConfig.inbounds = [
    {
      tag: "socks-in",
      listen: "127.0.0.1",
      port: ports.xray,
      protocol: "socks",
      settings: { auth: "noauth", udp: false },
    },
  ];

  const mihomoConfigObject = structuredClone(mihomoEntry.config);
  delete mihomoConfigObject["mixed-port"];
  delete mihomoConfigObject["redir-port"];
  delete mihomoConfigObject["external-controller"];
  mihomoConfigObject["socks-port"] = ports.mihomo;
  mihomoConfigObject["allow-lan"] = false;
  mihomoConfigObject["bind-address"] = "127.0.0.1";
  mihomoConfigObject.mode = "rule";
  mihomoConfigObject["log-level"] = "warning";
  const mihomoConfig = stringifyYaml(mihomoConfigObject, { lineWidth: 0 });

  const singboxConfig = structuredClone(singboxParsed.config);
  singboxConfig.inbounds = [
    {
      type: "socks",
      tag: "socks-in",
      listen: "127.0.0.1",
      listen_port: ports.singbox,
    },
  ];

  const metadata = {
    nodeCount: xrayEntry.nodeCount,
    address: xrayEntry.address,
    port: 443,
    serverName: xrayEntry.serverName,
    path: xrayEntry.pathName,
    earlyData: EARLY_DATA,
    earlyDataHeader: EARLY_DATA_HEADER,
    clientPorts: ports,
  };

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDir, "xray.json"), `${JSON.stringify(xrayConfig, null, 2)}\n`),
    writeFile(resolve(outputDir, "mihomo.yaml"), mihomoConfig),
    writeFile(resolve(outputDir, "sing-box.json"), `${JSON.stringify(singboxConfig, null, 2)}\n`),
    writeFile(resolve(outputDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`),
  ]);
  return metadata;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assert(key?.startsWith("--") && value, `参数无效: ${key || "(empty)"}`);
    values[key.slice(2)] = value;
  }
  for (const required of ["base64", "xray", "mihomo", "singbox", "output-dir"]) {
    assert(values[required], `缺少 --${required}`);
  }
  return values;
}

const invokedAsScript =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const metadata = await prepareClientConfigs({
      base64Path: resolve(args.base64),
      xrayPath: resolve(args.xray),
      mihomoPath: resolve(args.mihomo),
      singboxPath: resolve(args.singbox),
      outputDir: resolve(args["output-dir"]),
    });
    process.stdout.write(
      `OK prepared host=${metadata.serverName} path=${metadata.path} earlyData=${metadata.earlyData}\n`,
    );
  } catch (error) {
    process.stderr.write(`ERROR ${(error instanceof Error && error.message) || String(error)}\n`);
    process.exitCode = 1;
  }
}
