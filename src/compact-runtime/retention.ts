import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

interface StoredRun {
  day: string;
  runId: string;
  path: string;
  bytes: number;
}

async function listRuns(root: string): Promise<StoredRun[]> {
  const runs: StoredRun[] = [];
  let days;
  try {
    days = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return runs;
  }

  for (const day of days) {
    const dayPath = path.join(root, day);
    const entries = await readdir(dayPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^run_[A-Za-z0-9_]+$/.test(entry.name)) continue;
      const runPath = path.join(dayPath, entry.name);
      runs.push({
        day,
        runId: entry.name,
        path: runPath,
        bytes: await directoryBytes(runPath),
      });
    }
  }

  return runs.sort((left, right) =>
    left.day.localeCompare(right.day) || left.runId.localeCompare(right.runId),
  );
}

async function removeEmptyDays(root: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const dayPath = path.join(root, entry.name);
    if ((await readdir(dayPath)).length === 0) await rm(dayPath, { recursive: true, force: true });
  }
}

export async function pruneRunStore(input: {
  root: string;
  now?: number;
  protectRunId?: string;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const retentionDays = positiveIntegerEnv(
    "DEVSPACE_COMPACT_LOG_RETENTION_DAYS",
    DEFAULT_RETENTION_DAYS,
  );
  const maxBytes = positiveIntegerEnv(
    "DEVSPACE_COMPACT_LOG_MAX_BYTES",
    DEFAULT_MAX_BYTES,
  );
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;

  let runs = await listRuns(input.root);

  for (const run of runs) {
    if (run.runId === input.protectRunId) continue;
    const dayTime = Date.parse(`${run.day}T00:00:00Z`);
    if (Number.isFinite(dayTime) && dayTime < cutoff) {
      await rm(run.path, { recursive: true, force: true });
    }
  }

  runs = await listRuns(input.root);
  let total = runs.reduce((sum, run) => sum + run.bytes, 0);
  for (const run of runs) {
    if (total <= maxBytes) break;
    if (run.runId === input.protectRunId) continue;
    await rm(run.path, { recursive: true, force: true });
    total -= run.bytes;
  }

  await removeEmptyDays(input.root);
}
