import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { selectValidatedCandidates } from "../../../infra/scripts/optimized-ip-selection.mjs";

const records = [
  { ip: "203.0.113.9", localMs: 70, remoteMs: 80 },
  { ip: "203.0.113.1", localMs: 20, remoteMs: 30 },
  { ip: "203.0.113.2", localMs: 20, remoteMs: 40 },
  { ip: "203.0.113.3", localMs: 50, remoteMs: 45 },
  { ip: "203.0.113.4", localMs: 60, remoteMs: 55 },
  { ip: "203.0.113.5", localMs: 70, remoteMs: 65 },
  { ip: "203.0.113.6", localMs: 80, remoteMs: 75 },
  { ip: "203.0.113.7", localMs: 90, remoteMs: 85 },
  { ip: "203.0.113.8", localMs: 100, remoteMs: 95 },
  { ip: "203.0.113.1", localMs: 1000, remoteMs: 1000 },
  { ip: "not-an-ip", localMs: 1, remoteMs: 1 },
  { ip: "203.0.113.10", localMs: -1, remoteMs: 1 },
];

const selected = selectValidatedCandidates(records, 8);
assert.equal(selected.length, 8);
assert.deepEqual(
  selected.map((record) => record.ip),
  [
    "203.0.113.1",
    "203.0.113.2",
    "203.0.113.3",
    "203.0.113.4",
    "203.0.113.5",
    "203.0.113.9",
    "203.0.113.6",
    "203.0.113.7",
  ],
);

const optimizerScript = await readFile(
  fileURLToPath(new URL("../../../infra/scripts/optimize-ip.sh", import.meta.url)),
  "utf8",
);
const optimizerWorkflow = await readFile(
  fileURLToPath(new URL("../../../.github/workflows/optimize-ip.yml", import.meta.url)),
  "utf8",
);
assert.match(optimizerScript, /if len\(seen\) >= 64:/, "global candidate pool must inspect 64 IPs");
assert.match(optimizerScript, /if len\(seen\) >= 32:/, "each worker must inspect up to 32 IPs");
assert.match(optimizerScript, /PROBE_TARGET=8/, "each worker must target eight validated IPs");
assert.match(optimizerScript, /PROBE_BATCH_SIZE=4/, "probe concurrency must stay bounded at four");
assert.match(optimizerScript, /optimized-ip-selection\.mjs/, "publish path must use scored selection");
assert.match(optimizerScript, /12 \* 60 \* 60 \* 1000/, "published pool TTL must be 12 hours");
assert.match(optimizerWorkflow, /cron:\s*['"]17 \*\/4 \* \* \*['"]/, "optimizer must run every four hours");
assert.match(
  optimizerWorkflow,
  /LANDING_SOCKS_PORT:\s*\$\{\{ vars\.SERVICES_PORT \}\}/,
  "optimizer must receive the configured landing SOCKS port",
);
assert.match(optimizerScript, /REMOTE_MODE=socks5/, "SOCKS must be a supported landing vantage");
assert.match(optimizerScript, /--proxy-host/, "landing vantage must route VLESS through SOCKS");
assert.deepEqual(
  selected.map((record) => record.scoreMs),
  [30, 40, 50, 60, 70, 80, 80, 90],
);

const workDir = await mkdtemp(join(tmpdir(), "opus8-opt-selection-"));
try {
  const resultsDir = join(workDir, "results");
  await mkdir(resultsDir);
  await Promise.all(
    records.slice(0, 9).map((record, index) =>
      writeFile(join(resultsDir, `${index}.json`), JSON.stringify(record)),
    ),
  );
  const cli = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../../../infra/scripts/optimized-ip-selection.mjs", import.meta.url)),
      resultsDir,
      "8",
    ],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), selected.map((record) => record.ip));
} finally {
  await rm(workDir, { recursive: true, force: true });
}

const python = process.platform === "win32" ? "python" : "python3";
const proxyTest = spawnSync(
  python,
  [fileURLToPath(new URL("../../../infra/scripts/smoke-vless-proxy-test.py", import.meta.url))],
  { encoding: "utf8" },
);
assert.equal(proxyTest.status, 0, proxyTest.stderr || proxyTest.stdout);

console.log("OK optimized IP selection tests");
