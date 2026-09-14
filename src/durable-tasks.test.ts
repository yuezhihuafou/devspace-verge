import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { handleRunLogCommand } from "./compact-runtime/run-log-access.js";
import { runDurableTask, type DurableTaskRequest } from "./durable-task-runner.js";
import { DurableTaskManager } from "./durable-tasks.js";

const node = process.platform === "win32"
  ? `"${process.execPath}"`
  : JSON.stringify(process.execPath);

test("durable task runner persists output and terminal metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-runner-"));
  try {
    const runId = "run_20260914120000_runner";
    const runDir = path.join(root, "2026-09-14", runId);
    await mkdir(runDir, { recursive: true });
    const requestPath = path.join(runDir, "request.json");
    const request: DurableTaskRequest = {
      schemaVersion: 1,
      taskId: runId,
      runId,
      command: `${node} -e "console.log('durable-runner-ok')"`,
      cwd: process.cwd(),
      root: process.cwd(),
      runRoot: root,
      outputPath: path.join(runDir, "output.log"),
      taskPath: path.join(runDir, "task.json"),
      metaPath: path.join(runDir, "meta.json"),
      startedAt: new Date().toISOString(),
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    };
    await writeFile(request.outputPath, "", { mode: 0o600 });
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });

    const exitCode = await runDurableTask(requestPath);
    assert.equal(exitCode, 0);
    assert.match(await readFile(request.outputPath, "utf8"), /durable-runner-ok/);
    const task = JSON.parse(await readFile(request.taskPath, "utf8")) as { status: string; outputLines: number };
    assert.equal(task.status, "completed");
    assert.equal(task.outputLines, 1);
    const meta = JSON.parse(await readFile(request.metaPath, "utf8")) as { exitCode: number; isError: boolean };
    assert.equal(meta.exitCode, 0);
    assert.equal(meta.isError, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable task manager returns promptly and run logs become queryable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-manager-"));
  const previousRoot = process.env.DEVSPACE_COMPACT_RUN_ROOT;
  process.env.DEVSPACE_COMPACT_RUN_ROOT = root;
  try {
    const manager = new DurableTaskManager({
      runRoot: root,
      runnerPath: "test-runner",
      launchTask: async ({ requestPath }) => {
        void runDurableTask(requestPath);
      },
    });
    const snapshot = await manager.start({
      workspaceId: "workspace-a",
      workspaceRoot: process.cwd(),
      cwd: process.cwd(),
      command: `${node} -e "console.log('durable-start'); setTimeout(() => console.log('durable-done'), 120)"`,
    }, 5);

    assert.equal(snapshot.running, true);
    assert.equal(snapshot.sessionId, undefined);
    assert.match(snapshot.runId, /^run_/);

    await new Promise((resolve) => setTimeout(resolve, 250));
    const meta = JSON.parse(await handleRunLogCommand(`devspace-log meta ${snapshot.runId}`) as string) as {
      exitCode: number;
      isError: boolean;
    };
    assert.equal(meta.exitCode, 0);
    assert.equal(meta.isError, false);
    const output = await handleRunLogCommand(`devspace-log read ${snapshot.runId} 1 20`);
    assert.match(output as string, /durable-start/);
    assert.match(output as string, /durable-done/);
  } finally {
    if (previousRoot === undefined) delete process.env.DEVSPACE_COMPACT_RUN_ROOT;
    else process.env.DEVSPACE_COMPACT_RUN_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
