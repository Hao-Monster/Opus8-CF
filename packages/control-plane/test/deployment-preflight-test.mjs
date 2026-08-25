import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  formatControlDeployErrors,
  validateControlDeployEnvironment
} from "../../../infra/scripts/control-deploy-preflight.mjs";
import { normalizeWorkerPlacementHost } from "../../../infra/scripts/worker-placement-host.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function validEnvironment() {
  return {
    ROOT_DOMAIN: "example.com",
    ADMIN_PASSWORD: "a".repeat(16),
    JWT_SECRET: "j".repeat(32),
    NODE_HMAC_SECRET: "n".repeat(32),
    LANDING_CONFIG_KEY: "existing-landing-config-key-32-bytes",
    FREEDOMPOST_INTEGRATION_KEY_ID: "freedompost-prod",
    FREEDOMPOST_INTEGRATION_SECRET: "f".repeat(32),
    AUTOMATION_HMAC_SECRET: "a".repeat(32)
  };
}

test("accepts a complete control-plane deployment environment", () => {
  assert.deepEqual(validateControlDeployEnvironment(validEnvironment()), []);
});

test("fails closed when FreedomPost integration credentials are absent", () => {
  const environment = validEnvironment();
  delete environment.FREEDOMPOST_INTEGRATION_KEY_ID;
  delete environment.FREEDOMPOST_INTEGRATION_SECRET;
  const names = validateControlDeployEnvironment(environment).map((error) => error.name);
  assert.ok(names.includes("FREEDOMPOST_INTEGRATION_KEY_ID"));
  assert.ok(names.includes("FREEDOMPOST_INTEGRATION_SECRET"));
});

test("fails closed when the deployment automation secret is absent", () => {
  const environment = validEnvironment();
  delete environment.AUTOMATION_HMAC_SECRET;
  const names = validateControlDeployEnvironment(environment).map((error) => error.name);
  assert.ok(names.includes("AUTOMATION_HMAC_SECRET"));
});

test("keeps compatibility with existing derived landing encryption secrets", () => {
  const environment = validEnvironment();
  environment.LANDING_CONFIG_KEY = "raw-landing-secret-compatible-value";
  assert.deepEqual(validateControlDeployEnvironment(environment), []);
});

test("rejects malformed integration credentials without exposing values", () => {
  const environment = validEnvironment();
  environment.FREEDOMPOST_INTEGRATION_KEY_ID = "bad key";
  environment.FREEDOMPOST_INTEGRATION_SECRET = "leak-probe";
  const output = formatControlDeployErrors(validateControlDeployEnvironment(environment));
  assert.match(output, /FREEDOMPOST_INTEGRATION_KEY_ID/);
  assert.match(output, /FREEDOMPOST_INTEGRATION_SECRET/);
  assert.doesNotMatch(output, /bad key|leak-probe/);
});

test("workflow and deploy script inject both integration secrets", () => {
  const workflow = readFileSync(
    `${repositoryRoot}.github/workflows/deploy-control.yml`,
    "utf8"
  );
  const deployScript = readFileSync(
    `${repositoryRoot}infra/scripts/deploy-control.sh`,
    "utf8"
  );
  for (const name of [
    "FREEDOMPOST_INTEGRATION_KEY_ID",
    "FREEDOMPOST_INTEGRATION_SECRET"
  ]) {
    assert.match(workflow, new RegExp(`secrets\\.${name}`));
    assert.match(deployScript, new RegExp(`put_secret "${name}"`));
  }
  assert.match(deployScript, /control-deploy-preflight\.mjs/);
  assert.match(deployScript, /name = "ADMIN_LOGIN_RATE_LIMITER"/);
  assert.match(deployScript, /crons = \["17 \*\/6 \* \* \*"\]/);
  assert.match(deployScript, /\[observability\.logs\]/);
});

test("node jobs use just-in-time enrollment without the control root", () => {
  const workflow = readFileSync(
    `${repositoryRoot}.github/workflows/deploy-nodes.yml`,
    "utf8",
  );
  const zeroTrustWorkflow = readFileSync(
    `${repositoryRoot}.github/workflows/enroll-zero-trust.yml`,
    "utf8",
  );
  const deployNodeScript = readFileSync(
    `${repositoryRoot}infra/scripts/deploy-node.sh`,
    "utf8",
  );
  assert.doesNotMatch(workflow, /secrets\.NODE_HMAC_SECRET/);
  assert.doesNotMatch(workflow, /ADMIN_PASSWORD|api\/admin\/login/);
  assert.doesNotMatch(deployNodeScript, /ADMIN_PASSWORD|api\/admin\/login/);
  assert.doesNotMatch(zeroTrustWorkflow, /secrets\.NODE_HMAC_SECRET/);
  assert.match(workflow, /api\/node-enrollments/);
  assert.match(workflow, /CONTROL_AUTOMATION_SECRET/);
  assert.match(workflow, /node-deploy-matrix\.mjs/);
  assert.match(workflow, /secrets\[matrix\.api_token_secret\]/);
  assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID/);
  assert.match(workflow, /NODE_ENROLLMENT_TOKEN/);
  assert.match(deployNodeScript, /control-automation-request\.mjs/);
  assert.match(workflow, /vars\.WORKER_PLACEMENT_HOST/);
  assert.match(workflow, /SERVICES_PORT:\s*\$\{\{ vars\.SERVICES_PORT \}\}/);
  assert.doesNotMatch(workflow, /format\([^\n]*SERVICES_IP/);
  assert.match(deployNodeScript, /worker-placement-host\.mjs/);
  assert.match(deployNodeScript, /\[placement\]\\nhost =/);
  assert.match(deployNodeScript, /ERROR invalid-services-port/);
  assert.match(deployNodeScript, /ERROR configured-landing-unavailable/);
  assert.match(deployNodeScript, /rejected=socks5-noauth/);
  const landingProbe = deployNodeScript.slice(
    deployNodeScript.indexOf("probe_socks5_port()"),
    deployNodeScript.indexOf("# 显式端口是部署契约"),
  );
  assert.ok(
    landingProbe.indexOf("outn=$(curl") < landingProbe.indexOf("out=$(curl"),
    "an unauthenticated SOCKS endpoint must be rejected before accepting credentials",
  );
  assert.match(
    deployNodeScript,
    /STEP transport-legacy-canary[\s\S]*?for n in \$\(seq 1 3\)/,
  );
});

test("health checks tolerate an unavailable optional VPS vantage", () => {
  const healthcheckScript = readFileSync(
    `${repositoryRoot}infra/scripts/healthcheck-nodes.sh`,
    "utf8",
  );
  assert.match(
    healthcheckScript,
    /\[ "\$REMOTE_READY" = "1" \] \|\| return 0/,
  );
  assert.match(
    healthcheckScript,
    /INVALIDATION_ACKNOWLEDGED[\s\S]*?INVALIDATION_ATTEMPTED[\s\S]*?POLICY_GRACE_SECONDS=65/,
  );
  assert.match(healthcheckScript, /sleep "\$POLICY_GRACE_SECONDS"/);
});

test("normalizes explicit Worker placement hosts", () => {
  assert.equal(normalizeWorkerPlacementHost(""), "");
  assert.equal(
    normalizeWorkerPlacementHost(" 203.0.113.10:40011 "),
    "203.0.113.10:40011",
  );
  assert.equal(
    normalizeWorkerPlacementHost("VPS.Example.COM:443"),
    "vps.example.com:443",
  );
  assert.equal(
    normalizeWorkerPlacementHost("[2001:db8::10]:40011"),
    "[2001:db8::10]:40011",
  );
});

test("rejects unsafe or malformed Worker placement hosts", () => {
  for (const value of [
    ":40011",
    "203.0.113.10:0",
    "203.0.113.10:65536",
    "999.999.999.999:40011",
    "bad..example.com:40011",
    "2001:db8::10:40011",
    "vps.example.com:40011\n[vars]",
  ]) {
    assert.throws(() => normalizeWorkerPlacementHost(value));
  }
});

test("placement host CLI is optional and fails closed without leaking input", () => {
  const cli = `${repositoryRoot}infra/scripts/worker-placement-host.mjs`;
  const absent = spawnSync(process.execPath, [cli], {
    encoding: "utf8",
    env: { ...process.env, WORKER_PLACEMENT_HOST: "" },
  });
  assert.equal(absent.status, 0);
  assert.equal(absent.stdout, "");
  assert.equal(absent.stderr, "");

  const unsafe = "vps.example.com:40011\n[vars]";
  const rejected = spawnSync(process.execPath, [cli], {
    encoding: "utf8",
    env: { ...process.env, WORKER_PLACEMENT_HOST: unsafe },
  });
  assert.equal(rejected.status, 9);
  assert.equal(rejected.stdout, "");
  assert.match(rejected.stderr, /ERROR invalid-worker-placement-host/);
  assert.doesNotMatch(rejected.stderr, /vps\.example\.com|\[vars\]/);
});
