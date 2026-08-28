import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const controlRoot = join(here, "..");
const repoRoot = resolve(controlRoot, "..", "..");
const manifestPath = join(repoRoot, "infra", "subscription-rules", "v1", "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.version, "v1");
assert.equal(manifest.assets.length, 10);
assert.equal(new Set(manifest.assets.map((asset) => asset.path)).size, manifest.assets.length);
assert.equal(new Set(manifest.assets.map((asset) => asset.key)).size, manifest.assets.length);

for (const asset of manifest.assets) {
  assert.match(asset.path, /^(mihomo\/[a-z_]+\.mrs|singbox\/[a-z_]+\.srs)$/);
  assert.match(asset.key, /^opus8:rules:v1:(mihomo|singbox):[a-z_]+\.(mrs|srs)$/);
  assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  assert(asset.source.startsWith("https://"));
  const bytes = await readFile(join(repoRoot, "infra", "subscription-rules", "v1", asset.path));
  assert.equal(bytes.byteLength, asset.size, `${asset.path} size mismatch`);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    asset.sha256,
    `${asset.path} checksum mismatch`,
  );
}

const bundled = await build({
  entryPoints: [join(controlRoot, "src", "subscription-rules.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const moduleUrl =
  "data:text/javascript;base64," +
  Buffer.from(bundled.outputFiles[0].text).toString("base64");
const { serveSubscriptionRule, subscriptionRuleManifest } = await import(moduleUrl);
const first = subscriptionRuleManifest().assets[0];
const expectedBytes = await readFile(
  join(repoRoot, "infra", "subscription-rules", "v1", first.path),
);
const expected = expectedBytes.buffer.slice(
  expectedBytes.byteOffset,
  expectedBytes.byteOffset + expectedBytes.byteLength,
);
const env = {
  KV: {
    async get(key, type) {
      assert.equal(key, first.key);
      assert.equal(type, "arrayBuffer");
      return expected;
    },
  },
};

const response = await serveSubscriptionRule(
  new Request(`https://sub.example/rules/v1/${first.path}`),
  env,
  first.path,
);
assert.equal(response.status, 200);
assert.equal(response.headers.get("etag"), `"sha256-${first.sha256}"`);
assert.match(response.headers.get("cache-control"), /immutable/);
assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array(expected));

const corrupted = await serveSubscriptionRule(
  new Request(`https://sub.example/rules/v1/${first.path}`),
  { KV: { async get() { return new TextEncoder().encode("corrupted").buffer; } } },
  first.path,
);
assert.equal(corrupted.status, 503);
assert.equal(corrupted.headers.get("cache-control"), "no-store");

const notModified = await serveSubscriptionRule(
  new Request(`https://sub.example/rules/v1/${first.path}`, {
    headers: { "if-none-match": `"sha256-${first.sha256}"` },
  }),
  env,
  first.path,
);
assert.equal(notModified.status, 304);

const missing = await serveSubscriptionRule(
  new Request("https://sub.example/rules/v1/../secret"),
  env,
  "../secret",
);
assert.equal(missing.status, 404);

const method = await serveSubscriptionRule(
  new Request(`https://sub.example/rules/v1/${first.path}`, { method: "POST" }),
  env,
  first.path,
);
assert.equal(method.status, 405);

console.log("OK subscription rule asset tests");
