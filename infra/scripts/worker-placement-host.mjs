import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function normalizePort(value) {
  if (!/^[0-9]{1,5}$/.test(value)) throw new Error("invalid placement port");
  const port = Number(value);
  if (port < 1 || port > 65_535) throw new Error("invalid placement port");
  return String(port);
}

function normalizeHostname(value) {
  if (value.length > 253 || /^[0-9.]+$/.test(value)) {
    throw new Error("invalid placement hostname");
  }
  const labels = value.split(".");
  if (labels.some((label) => !HOST_LABEL.test(label))) {
    throw new Error("invalid placement hostname");
  }
  return value.toLowerCase();
}

export function normalizeWorkerPlacementHost(value) {
  const candidate = String(value ?? "").trim();
  if (!candidate) return "";

  const bracketed = candidate.match(/^\[([^\]]+)\]:([0-9]{1,5})$/);
  if (bracketed) {
    if (isIP(bracketed[1]) !== 6) throw new Error("invalid placement IPv6 address");
    return `[${bracketed[1]}]:${normalizePort(bracketed[2])}`;
  }

  const separator = candidate.lastIndexOf(":");
  if (separator <= 0 || candidate.slice(0, separator).includes(":")) {
    throw new Error("placement host must use host:port");
  }
  const host = candidate.slice(0, separator);
  const port = normalizePort(candidate.slice(separator + 1));
  if (isIP(host) === 4) return `${host}:${port}`;
  return `${normalizeHostname(host)}:${port}`;
}

function runCli() {
  try {
    process.stdout.write(
      normalizeWorkerPlacementHost(process.env.WORKER_PLACEMENT_HOST),
    );
  } catch {
    process.stderr.write("ERROR invalid-worker-placement-host\n");
    process.exitCode = 9;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) runCli();
