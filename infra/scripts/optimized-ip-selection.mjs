#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function finiteLatency(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function selectValidatedCandidates(records, limit = 8) {
  const safeLimit = Math.max(1, Math.min(8, Math.trunc(limit) || 1));
  const bestByIp = new Map();
  for (const record of records) {
    if (
      !record ||
      typeof record !== "object" ||
      typeof record.ip !== "string" ||
      isIP(record.ip) !== 4 ||
      !finiteLatency(record.localMs) ||
      !finiteLatency(record.remoteMs)
    ) {
      continue;
    }
    const selected = {
      ip: record.ip,
      localMs: record.localMs,
      remoteMs: record.remoteMs,
      scoreMs: Math.max(record.localMs, record.remoteMs),
    };
    const previous = bestByIp.get(selected.ip);
    if (!previous || selected.scoreMs < previous.scoreMs) {
      bestByIp.set(selected.ip, selected);
    }
  }
  return [...bestByIp.values()]
    .sort(
      (left, right) =>
        left.scoreMs - right.scoreMs ||
        left.localMs - right.localMs ||
        left.remoteMs - right.remoteMs ||
        left.ip.localeCompare(right.ip, "en", { numeric: true }),
    )
    .slice(0, safeLimit);
}

async function readResults(directory) {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const records = [];
  for (const file of files) {
    try {
      records.push(JSON.parse(await readFile(resolve(directory, file), "utf8")));
    } catch {
      // A malformed or half-written probe result is not eligible for publish.
    }
  }
  return records;
}

const invokedAsScript =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  try {
    const directory = process.argv[2];
    const limit = Number(process.argv[3] || 8);
    if (!directory) throw new Error("results directory is required");
    const selected = selectValidatedCandidates(await readResults(directory), limit);
    process.stdout.write(`${JSON.stringify(selected.map((record) => record.ip))}\n`);
  } catch (error) {
    process.stderr.write(`ERROR ${(error instanceof Error && error.message) || String(error)}\n`);
    process.exitCode = 1;
  }
}
