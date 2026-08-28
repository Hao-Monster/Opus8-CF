import manifestSource from "../../../infra/subscription-rules/v1/manifest.json";
import type { Env } from "./db";

interface SubscriptionRuleAsset {
  path: string;
  key: string;
  size: number;
  sha256: string;
  contentType: string;
  source: string;
}

interface SubscriptionRuleManifest {
  schemaVersion: 1;
  version: "v1";
  assets: SubscriptionRuleAsset[];
}

const manifest = manifestSource as SubscriptionRuleManifest;
const assets = new Map(manifest.assets.map((asset) => [asset.path, asset]));

async function sha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function subscriptionRuleManifest(): SubscriptionRuleManifest {
  return manifest;
}

export async function serveSubscriptionRule(
  request: Request,
  env: Pick<Env, "KV">,
  assetPath: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed\n", {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "no-store" },
    });
  }
  const asset = assets.get(assetPath);
  if (!asset) {
    return new Response("Not Found\n", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }
  const etag = `"sha256-${asset.sha256}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: { etag, "cache-control": "public, max-age=86400, immutable" },
    });
  }
  const value = await env.KV.get(asset.key, "arrayBuffer");
  if (value === null) {
    return new Response("Rule asset unavailable\n", {
      status: 503,
      headers: { "cache-control": "no-store", "retry-after": "60" },
    });
  }
  if (value.byteLength !== asset.size || (await sha256Hex(value)) !== asset.sha256) {
    return new Response("Rule asset integrity check failed\n", {
      status: 503,
      headers: { "cache-control": "no-store", "retry-after": "60" },
    });
  }
  const headers = {
    "content-type": asset.contentType,
    "content-length": String(value.byteLength),
    "cache-control": "public, max-age=86400, immutable",
    etag,
    "x-content-type-options": "nosniff",
  };
  return new Response(request.method === "HEAD" ? null : value, { headers });
}
