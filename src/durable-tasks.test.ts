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
      schemaVersion: 2,
      taskId: "task_11111111-1111-4111-8111-111111111111",
      runId,
      workspaceId: "workspace-a",
      command: `${node} -e "console.log('durable-runner-ok')"`,
      cwd: process.cwd(),
      root: process.cwd(),
      runRoot: root,
      outputPath: path.join(runDir, "output.log"),
      taskPath: path.join(runDir, "task.json"),
      metaPath: path.join(runDir, "meta.json"),
      notificationPath: path.join(runDir, "notification.json"),
      startedAt: new Date().toISOString(),
      ttlMs: 30 * 24 * 60 * 60 * 1_000,
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    };
    await writeFile(request.outputPath, "", { mode: 0o600 });
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });

    const exitCode = await runDurableTask(requestPath);
    assert.equal(exitCode, 0);
    assert.match(await readFile(request.outputPath, "utf8"), /durable-runner-ok/);
    const task = JSON.parse(await readFile(request.taskPath, "utf8")) as {
      status: string;
      outputLines: number;
      result?: { isError?: boolean };
    };
    assert.equal(task.status, "completed");
    assert.equal(task.outputLines, 1);
    assert.equal(task.result?.isError, false);
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
    assert.match(snapshot.taskId ?? "", /^task_[0-9a-f-]{36}$/i);
    assert.match(snapshot.runId, /^run_/);

    const working = await manager.get(process.cwd(), snapshot.taskId as string);
    assert.equal(working.status, "working");
    assert.ok((working.pollIntervalMs ?? 0) > 0);

    await new Promise((resolve) => setTimeout(resolve, 250));
    const meta = JSON.parse(await handleRunLogCommand(`devspace-log meta ${snapshot.runId}`) as string) as {
      exitCode: number;
      isError: boolean;
    };
    assert.equal(meta.exitCode, 0);
    assert.equal(meta.isError, false);
    const completed = await manager.get(process.cwd(), snapshot.taskId as string);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.isError, false);
    assert.equal(completed.result?.exitCode, 0);
    const output = await handleRunLogCommand(`devspace-log read ${snapshot.runId} 1 20`);
    assert.match(output as string, /durable-start/);
    assert.match(output as string, /durable-done/);
  } finally {
    if (previousRoot === undefined) delete process.env.DEVSPACE_COMPACT_RUN_ROOT;
    else process.env.DEVSPACE_COMPACT_RUN_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("nonzero command is a completed task with an error tool result", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-nonzero-"));
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
      command: `${node} -e "process.exit(7)"`,
    }, 250);
    assert.ok(snapshot.taskId);
    const task = await manager.get(process.cwd(), snapshot.taskId);
    assert.equal(task.status, "completed");
    assert.equal(task.result?.isError, true);
    assert.equal(task.result?.exitCode, 7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task ownership is enforced", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-owner-"));
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
      command: `${node} -e "setTimeout(() => {}, 50)"`,
    }, 5);
    assert.ok(snapshot.taskId);
    await assert.rejects(
      manager.get(path.join(process.cwd(), "different-root"), snapshot.taskId),
      /does not belong to workspace/,
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const task = await manager.get(process.cwd(), snapshot.taskId);
      if (task.status !== "working") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal tasks persist a completion notification until task_get acknowledges it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-notify-"));
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
      command: `${node} -e "console.log('notify-done')"`,
    }, 250);
    assert.ok(snapshot.taskId);

    const pending = await manager.pendingNotifications(process.cwd());
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.taskId, snapshot.taskId);
    assert.equal(pending[0]?.status, "completed");

    const task = await manager.get(process.cwd(), snapshot.taskId);
    assert.equal(task.status, "completed");
    assert.deepEqual(await manager.pendingNotifications(process.cwd()), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
