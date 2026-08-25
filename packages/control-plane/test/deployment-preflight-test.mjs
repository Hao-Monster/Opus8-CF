import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  formatControlDeployErrors,
  validateControlDeployEnvironment
} from "../../../infra/scripts/control-deploy-preflight.mjs";

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
  assert.match(workflow, /format\('\{0\}:40011', secrets\.SERVICES_IP\)/);
  assert.match(deployNodeScript, /invalid-worker-placement-host/);
  assert.match(deployNodeScript, /\[placement\]\\nhost =/);
});
