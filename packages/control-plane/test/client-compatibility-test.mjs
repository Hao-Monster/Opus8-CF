import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareClientConfigs } from "../../../infra/scripts/prepare-client-configs.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const uuid = "11111111-2222-4333-8444-555555555555";
const host = "node.example.com";
const address = "203.0.113.10";
const path = "/ws/0123456789abcdef01234567";
const xrayPath = `${path}?ed=2560`;

function subscriptions({ singboxHost = host, insecure = false } = {}) {
  const query = new URLSearchParams({
    encryption: "none",
    security: "tls",
    sni: host,
    fp: "chrome",
    type: "ws",
    host,
    path: xrayPath,
  });
  const link = `vless://${uuid}@${address}:443?${query.toString()}#Opus8-test`;
  return {
    base64: Buffer.from(link, "utf8").toString("base64"),
    xray: JSON.stringify([
      {
        remarks: "Opus8-test",
        inbounds: [],
        outbounds: [
          {
            tag: "proxy",
            protocol: "vless",
            settings: {
              vnext: [
                {
                  address,
                  port: 443,
                  users: [{ id: uuid, encryption: "none" }],
                },
              ],
            },
            streamSettings: {
              network: "ws",
              security: "tls",
              tlsSettings: {
                serverName: host,
                allowInsecure: false,
                fingerprint: "chrome",
              },
              wsSettings: {
                path: xrayPath,
                headers: { Host: host },
              },
            },
          },
        ],
      },
    ]),
    mihomo: [
      "# Opus8-CF test subscription",
      "proxies:",
      '  - name: "Opus8-test"',
      "    type: vless",
      `    server: ${address}`,
      "    port: 443",
      `    uuid: ${uuid}`,
      "    network: ws",
      "    tls: true",
      "    udp: true",
      `    servername: ${host}`,
      "    client-fingerprint: chrome",
      ...(insecure ? ["    skip-cert-verify: true"] : []),
      "    ws-opts:",
      `      path: "${path}"`,
      "      headers:",
      `        Host: ${host}`,
      "      max-early-data: 2560",
      "      early-data-header-name: Sec-WebSocket-Protocol",
      "proxy-groups:",
      "  - name: Opus8",
      "    type: select",
      "    proxies:",
      '      - "Opus8-test"',
      "rules:",
      "  - MATCH,Opus8",
      "",
    ].join("\n"),
    singbox: JSON.stringify({
      outbounds: [
        {
          type: "vless",
          tag: "Opus8-test",
          server: address,
          server_port: 443,
          uuid,
          tls: { enabled: true, server_name: singboxHost, insecure: false },
          transport: {
            type: "ws",
            path,
            headers: { Host: singboxHost },
            max_early_data: 2560,
            early_data_header_name: "Sec-WebSocket-Protocol",
          },
        },
      ],
      route: { final: "Opus8-test" },
    }),
  };
}

async function writeSubscriptions(directory, values) {
  const paths = {
    base64Path: join(directory, "subscription.txt"),
    xrayPath: join(directory, "xray.json"),
    mihomoPath: join(directory, "subscription.yaml"),
    singboxPath: join(directory, "subscription.json"),
  };
  await Promise.all([
    writeFile(paths.base64Path, values.base64),
    writeFile(paths.xrayPath, values.xray),
    writeFile(paths.mihomoPath, values.mihomo),
    writeFile(paths.singboxPath, values.singbox),
  ]);
  return paths;
}

const workDir = await mkdtemp(join(tmpdir(), "opus8-client-config-test-"));
try {
  const inputDir = join(workDir, "input");
  const outputDir = join(workDir, "output");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(inputDir);
  const paths = await writeSubscriptions(inputDir, subscriptions());
  const metadata = await prepareClientConfigs({ ...paths, outputDir });

  assert.deepEqual(metadata.clientPorts, {
    xray: 18081,
    mihomo: 18082,
    singbox: 18083,
  });
  assert.equal(metadata.serverName, host);
  assert.equal(metadata.path, path);
  assert.equal(metadata.nodeCount, 1);
  assert(!JSON.stringify(metadata).includes(uuid), "metadata must not contain the canary UUID");

  const xray = JSON.parse(await readFile(join(outputDir, "xray.json"), "utf8"));
  assert.equal(xray.inbounds[0].protocol, "socks");
  assert.equal(xray.outbounds[0].streamSettings.security, "tls");
  assert.equal(xray.outbounds[0].streamSettings.tlsSettings.allowInsecure, false);
  assert.equal(xray.outbounds[0].streamSettings.tlsSettings.serverName, host);
  assert.equal(xray.outbounds[0].streamSettings.wsSettings.path, xrayPath);

  const mihomo = await readFile(join(outputDir, "mihomo.yaml"), "utf8");
  assert.match(mihomo, /^socks-port: 18082$/m);
  assert.match(mihomo, /^    tls: true$/m);
  assert.doesNotMatch(mihomo, /skip-cert-verify:\s*true/i);

  const singbox = JSON.parse(await readFile(join(outputDir, "sing-box.json"), "utf8"));
  assert.equal(singbox.inbounds[0].type, "socks");
  assert.equal(singbox.outbounds.find((outbound) => outbound.type === "vless").tls.insecure, false);
  assert.equal(singbox.route.final, "Opus8-test");

  const mismatchDir = join(workDir, "mismatch");
  await mkdir(mismatchDir);
  const mismatchPaths = await writeSubscriptions(
    mismatchDir,
    subscriptions({ singboxHost: "other.example.com" }),
  );
  await assert.rejects(
    prepareClientConfigs({
      ...mismatchPaths,
      outputDir: join(workDir, "mismatch-output"),
    }),
    /SNI|Host|不一致/,
  );

  const insecureDir = join(workDir, "insecure");
  await mkdir(insecureDir);
  const insecurePaths = await writeSubscriptions(
    insecureDir,
    subscriptions({ insecure: true }),
  );
  await assert.rejects(
    prepareClientConfigs({
      ...insecurePaths,
      outputDir: join(workDir, "insecure-output"),
    }),
    /禁止跳过证书校验/,
  );

  const manifest = JSON.parse(
    await readFile(join(repoRoot, "infra/client-compatibility.json"), "utf8"),
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.platform, "linux-amd64");
  for (const [client, entry] of Object.entries(manifest.clients)) {
    assert.match(entry.version, /^\d+\.\d+\.\d+$/);
    assert.equal(entry.releaseTag, `v${entry.version}`);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.match(entry.url, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//);
    assert(entry.url.includes(entry.releaseTag), `${client} URL must pin its release tag`);
    assert(entry.url.endsWith(entry.asset), `${client} URL must pin its asset`);
  }

  const workflow = await readFile(
    join(repoRoot, ".github/workflows/client-compatibility.yml"),
    "utf8",
  ).catch(() => "");
  const runner = await readFile(
    join(repoRoot, "infra/scripts/client-compatibility.sh"),
    "utf8",
  ).catch(() => "");
  if (workflow || runner) {
    assert.match(workflow, /permissions:\s*\n\s+contents: read/);
    assert.doesNotMatch(workflow, /issues:\s*write|pull-requests:\s*write/);
    assert.match(runner, /connections/);
    assert.match(runner, /bytes_up/);
    assert.match(runner, /bytes_down/);
  }

  console.log("client compatibility config tests passed");
} finally {
  await rm(workDir, { recursive: true, force: true });
}
