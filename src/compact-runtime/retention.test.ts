import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pruneRunStore } from "./retention.js";

const root = await mkdtemp(path.join(tmpdir(), "devspace-retention-"));
const previousMax = process.env.DEVSPACE_COMPACT_LOG_MAX_BYTES;
const previousDays = process.env.DEVSPACE_COMPACT_LOG_RETENTION_DAYS;

async function makeRun(
  day: string,
  runId: string,
  bytes: number,
  completed = true,
): Promise<string> {
  const runDir = path.join(root, day, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "output.log"), Buffer.alloc(bytes, 0x78));
  if (completed) await writeFile(path.join(runDir, "meta.json"), "{}\n");
  return runDir;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

try {
  process.env.DEVSPACE_COMPACT_LOG_MAX_BYTES = "250";
  process.env.DEVSPACE_COMPACT_LOG_RETENTION_DAYS = "30";

  const day = "2026-09-05";
  const oldest = await makeRun(day, "run_20260905010000_aaaaaaaa", 200);
  const middle = await makeRun(day, "run_20260905020000_bbbbbbbb", 200);
  const newest = await makeRun(day, "run_20260905030000_cccccccc", 200);
  const active = await makeRun(day, "run_20260905040000_dddddddd", 200, false);

  await pruneRunStore({
    root,
    now: Date.parse("2026-09-05T12:00:00Z"),
    protectRunId: "run_20260905030000_cccccccc",
  });

  assert.equal(await exists(oldest), false);
  assert.equal(await exists(middle), false);
  assert.equal(await exists(newest), true);
  assert.equal(await exists(active), true);

  process.env.DEVSPACE_COMPACT_LOG_MAX_BYTES = "100000";
  process.env.DEVSPACE_COMPACT_LOG_RETENTION_DAYS = "1";
  const oldRun = await makeRun("2026-09-01", "run_20260901010000_eeeeeeee", 10);
  const oldActive = await makeRun("2026-09-01", "run_20260901020000_ffffffff", 10, false);
  await pruneRunStore({
    root,
    now: Date.parse("2026-09-05T12:00:00Z"),
    protectRunId: "run_20260905030000_cccccccc",
  });
  assert.equal(await exists(oldRun), false);
  assert.equal(await exists(oldActive), true);
  assert.equal(await exists(newest), true);
} finally {
  if (previousMax === undefined) delete process.env.DEVSPACE_COMPACT_LOG_MAX_BYTES;
  else process.env.DEVSPACE_COMPACT_LOG_MAX_BYTES = previousMax;
  if (previousDays === undefined) delete process.env.DEVSPACE_COMPACT_LOG_RETENTION_DAYS;
  else process.env.DEVSPACE_COMPACT_LOG_RETENTION_DAYS = previousDays;
  await rm(root, { recursive: true, force: true });
}
