import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

function fail(message) {
  throw new Error(message);
}

export function verifyOptimizedSubscription(subscription, expectedNodes, perNodeLimit) {
  if (!Number.isInteger(perNodeLimit) || perNodeLimit < 1 || perNodeLimit > 8) {
    fail("per-node optimized IP limit must be an integer from 1 to 8");
  }
  if (!expectedNodes || typeof expectedNodes !== "object" || Array.isArray(expectedNodes)) {
    fail("expected optimized IP pool must be an object");
  }

  const nodesByHostname = new Map();
  const actualByNode = new Map();
  for (const [nodeId, node] of Object.entries(expectedNodes)) {
    if (
      !node
      || typeof node.hostname !== "string"
      || typeof node.transportPath !== "string"
      || !Array.isArray(node.ips)
      || node.ips.some((ip) => isIP(ip) !== 4)
    ) {
      fail(`invalid expected optimized IP record for node=${nodeId}`);
    }
    if (nodesByHostname.has(node.hostname)) {
      fail(`duplicate optimized IP hostname=${node.hostname}`);
    }
    nodesByHostname.set(node.hostname, { nodeId, ...node });
    actualByNode.set(nodeId, new Set());
  }

  for (const line of String(subscription).split(/\r?\n/).filter(Boolean)) {
    let url;
    try {
      url = new URL(line);
    } catch {
      fail("subscription contains an invalid URL");
    }
    if (isIP(url.hostname) !== 4) continue;
    const sni = url.searchParams.get("sni") || "";
    const host = url.searchParams.get("host") || "";
    const node = nodesByHostname.get(sni);
    if (!node || host !== sni || !node.ips.includes(url.hostname)) {
      fail(`subscription contains unvalidated optimized IP=${url.hostname}`);
    }
    if (url.searchParams.get("path") !== `${node.transportPath}?ed=2560`) {
      fail(`subscription transport path mismatch for node=${node.nodeId}`);
    }
    const actual = actualByNode.get(node.nodeId);
    if (actual.has(url.hostname)) {
      fail(`subscription contains duplicate optimized IP for node=${node.nodeId}`);
    }
    actual.add(url.hostname);
  }

  let ipCount = 0;
  for (const [nodeId, node] of Object.entries(expectedNodes)) {
    const expected = new Set(node.ips.slice(0, perNodeLimit));
    const actual = actualByNode.get(nodeId);
    if (actual.size !== expected.size) {
      fail(
        `node=${nodeId} expected ${expected.size} optimized IPs, received ${actual.size}`,
      );
    }
    for (const ip of actual) {
      if (!expected.has(ip)) {
        fail(`node=${nodeId} subscription selected unexpected optimized IP=${ip}`);
      }
    }
    ipCount += actual.size;
  }
  return { nodeCount: Object.keys(expectedNodes).length, ipCount };
}

function main(argv) {
  if (argv.length !== 3) {
    throw new Error(
      "usage: verify-optimized-subscription.mjs <subscription> <pool> <per-node-limit>",
    );
  }
  const result = verifyOptimizedSubscription(
    readFileSync(argv[0], "utf8"),
    JSON.parse(readFileSync(argv[1], "utf8")),
    Number(argv[2]),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
