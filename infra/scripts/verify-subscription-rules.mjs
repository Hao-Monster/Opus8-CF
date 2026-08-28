#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rulesRoot = join(repoRoot, "infra", "subscription-rules", "v1");

export async function verifySubscriptionRules() {
  const manifest = JSON.parse(await readFile(join(rulesRoot, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.version !== "v1" || !Array.isArray(manifest.assets)) {
    throw new Error("invalid subscription rule manifest");
  }
  const paths = new Set();
  const keys = new Set();
  for (const asset of manifest.assets) {
    if (
      typeof asset.path !== "string" ||
      !/^(mihomo\/[a-z_]+\.mrs|singbox\/[a-z_]+\.srs)$/.test(asset.path) ||
      typeof asset.key !== "string" ||
      !/^opus8:rules:v1:(mihomo|singbox):[a-z_]+\.(mrs|srs)$/.test(asset.key) ||
      typeof asset.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      paths.has(asset.path) ||
      keys.has(asset.key)
    ) {
      throw new Error(`invalid subscription rule asset: ${asset.path || "unknown"}`);
    }
    paths.add(asset.path);
    keys.add(asset.key);
    const bytes = await readFile(join(rulesRoot, asset.path));
    if (bytes.byteLength !== asset.size) throw new Error(`${asset.path} size mismatch`);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== asset.sha256) throw new Error(`${asset.path} checksum mismatch`);
  }
  return manifest;
}

try {
  const manifest = await verifySubscriptionRules();
  if (process.argv.includes("--list")) {
    for (const asset of manifest.assets) {
      process.stdout.write(`${asset.key}\t${asset.path}\t${asset.sha256}\n`);
    }
  } else {
    process.stdout.write(`OK subscription-rules version=${manifest.version} assets=${manifest.assets.length}\n`);
  }
} catch (error) {
  process.stderr.write(`ERROR ${(error instanceof Error && error.message) || String(error)}\n`);
  process.exitCode = 1;
}
