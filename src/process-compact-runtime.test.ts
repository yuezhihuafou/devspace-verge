import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleRunLogCommand } from "./compact-runtime/run-log-access.js";
import { ProcessSessionManager } from "./process-sessions.js";

const root = await mkdtemp(path.join(tmpdir(), "devspace-process-runs-"));
const previousRoot = process.env.DEVSPACE_COMPACT_RUN_ROOT;
process.env.DEVSPACE_COMPACT_RUN_ROOT = root;

const manager = new ProcessSessionManager({
  maxBufferCharacters: 2_048,
  completedSessionTtlMs: 1_000,
  runRoot: root,
});

const node = process.platform === "win32"
  ? `"${process.execPath}"`
  : JSON.stringify(process.execPath);

try {
  const noisy = await manager.start({
    workspaceId: "workspace-a",
    workspaceRoot: process.cwd(),
    cwd: process.cwd(),
    command: `${node} -e "process.stdout.write('x'.repeat(120000))"`,
    yieldTimeMs: 5_000,
    maxOutputTokens: 64,
  });

  assert.equal(noisy.running, false);
  assert.equal(noisy.exitCode, 0);
  assert.ok(noisy.runId.startsWith("run_"));
  assert.equal(noisy.outputTruncated, true);
  assert.ok(noisy.output.length < 3_000);
  assert.equal(noisy.outputBytes, 120_000);

  const noisyMeta = JSON.parse(await handleRunLogCommand(`devspace-log meta ${noisy.runId}`) as string);
  assert.equal(noisyMeta.exitCode, 0);
  assert.equal(noisyMeta.outputBytes, 120_000);
  assert.equal((await readFile(noisyMeta.outputPath)).length, 120_000);

  const background = await manager.start({
    workspaceId: "workspace-a",
    workspaceRoot: process.cwd(),
    cwd: process.cwd(),
    command: `${node} -e "console.log('started'); setTimeout(() => console.log('finished'), 100)"`,
    yieldTimeMs: 5,
  });

  assert.equal(background.running, true);
  assert.ok(background.sessionId);
  const runId = background.runId;

  const completed = await manager.write({
    workspaceId: "workspace-a",
    sessionId: background.sessionId,
    yieldTimeMs: 2_000,
  });

  assert.equal(completed.running, false);
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.runId, runId);
  const full = await handleRunLogCommand(`devspace-log read ${runId} 1 20`);
  assert.match(full as string, /started/);
  assert.match(full as string, /finished/);

  const meta = JSON.parse(await handleRunLogCommand(`devspace-log meta ${runId}`) as string);
  assert.equal(meta.exitCode, 0);
  assert.equal(meta.signal, null);
  assert.ok(meta.outputBytes >= Buffer.byteLength("started\nfinished\n"));
} finally {
  manager.shutdown();
  if (previousRoot === undefined) delete process.env.DEVSPACE_COMPACT_RUN_ROOT;
  else process.env.DEVSPACE_COMPACT_RUN_ROOT = previousRoot;
  await rm(root, { recursive: true, force: true });
}
