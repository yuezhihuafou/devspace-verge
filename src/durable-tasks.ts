import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runStoreRoot } from "./compact-runtime/run-store.js";
import type { DurableTaskRequest } from "./durable-task-runner.js";
import {
  durableTaskView,
  taskPollIntervalMs,
  type DurableTaskState,
  type DurableTaskView,
} from "./durable-task-model.js";
import type { ProcessSnapshot, StartCommandInput } from "./process-sessions.js";

const execFileAsync = promisify(execFile);
const DEFAULT_PREVIEW_CHARACTERS = 40_000;
const TASK_HEARTBEAT_STALE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface DurableTaskLauncherInput {
  requestPath: string;
  unitName: string;
  runnerPath: string;
}

export interface DurableTaskManagerOptions {
  runRoot?: string;
  runnerPath?: string;
  launchTask?: (input: DurableTaskLauncherInput) => Promise<void>;
}

export interface DurableTaskNotification {
  taskId: string;
  runId: string;
  status: "completed" | "cancelled" | "failed";
  statusMessage?: string;
  lastUpdatedAt: string;
}

interface DurableTaskActiveMarker {
  schemaVersion: 1;
  taskId: string;
  runId: string;
  root: string;
  taskPath: string;
}

function taskEnvironment(input: StartCommandInput): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    NO_COLOR: "1",
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    CODEX_CI: "1",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    DEVSPACE_WORKSPACE_ID: input.workspaceId,
    DEVSPACE_WORKSPACE_ROOT: input.workspaceRoot ?? input.cwd,
  };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
}

function runIdFor(now: Date): string {
  return `run_${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
}

function taskIdFor(): string {
  return `task_${randomUUID()}`;
}

function taskTtlMs(): number {
  const parsed = Number.parseInt(process.env.DEVSPACE_COMPACT_LOG_RETENTION_DAYS ?? "", 10);
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  return days * DAY_MS;
}

function workspaceKey(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 32);
}

function systemdUserAvailable(): boolean {
  if (process.platform !== "linux") return false;
  const result = spawnSync("systemctl", ["--user", "show-environment"], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 1_500,
  });
  return !result.error && result.status === 0;
}

async function readPreview(filePath: string, maxCharacters = DEFAULT_PREVIEW_CHARACTERS): Promise<{
  output: string;
  truncated: boolean;
}> {
  const info = await stat(filePath);
  if (info.size === 0) return { output: "", truncated: false };
  const maxBytes = Math.max(1_024, maxCharacters * 2);
  if (info.size <= maxBytes) {
    return { output: await readFile(filePath, "utf8"), truncated: false };
  }

  const half = Math.floor(maxBytes / 2);
  const handle = await open(filePath, "r");
  try {
    const head = Buffer.alloc(half);
    const tail = Buffer.alloc(half);
    const headRead = await handle.read(head, 0, half, 0);
    const tailRead = await handle.read(tail, 0, half, Math.max(0, info.size - half));
    return {
      output: `${head.subarray(0, headRead.bytesRead).toString("utf8")}\n... output truncated ...\n${tail.subarray(0, tailRead.bytesRead).toString("utf8")}`,
      truncated: true,
    };
  } finally {
    await handle.close();
  }
}

async function readState(taskPath: string): Promise<DurableTaskState> {
  return JSON.parse(await readFile(taskPath, "utf8")) as DurableTaskState;
}

function runningState(state: DurableTaskState): boolean {
  if (state.status !== "working") return false;
  const updatedAt = Date.parse(state.lastUpdatedAt);
  return !Number.isFinite(updatedAt) || Date.now() - updatedAt <= TASK_HEARTBEAT_STALE_MS;
}

export class DurableTaskManager {
  readonly available: boolean;
  private readonly runRoot: string;
  private readonly runnerPath: string;
  private readonly launchOverride?: DurableTaskManagerOptions["launchTask"];

  constructor(options: DurableTaskManagerOptions = {}) {
    this.runRoot = options.runRoot ?? runStoreRoot();
    this.runnerPath = options.runnerPath
      ?? fileURLToPath(new URL("./durable-task-runner.js", import.meta.url));
    this.launchOverride = options.launchTask;
    this.available = Boolean(this.launchOverride) || existsSync(this.runnerPath);
  }

  async start(input: StartCommandInput, waitMs: number): Promise<ProcessSnapshot> {
    if (!this.available) throw new Error("Durable task runner is unavailable in this build.");
    const now = new Date();
    const runId = runIdFor(now);
    const runDir = path.join(this.runRoot, now.toISOString().slice(0, 10), runId);
    const outputPath = path.join(runDir, "output.log");
    const taskPath = path.join(runDir, "task.json");
    const metaPath = path.join(runDir, "meta.json");
    const requestPath = path.join(runDir, "request.json");
    const taskId = taskIdFor();
    const unitName = `devspace-task-${runId}`;
    const indexPath = this.taskIndexPath(taskId);
    const workspaceRoot = input.workspaceRoot ?? input.cwd;
    const notificationPath = this.notificationPath(workspaceRoot, taskId);
    const activePath = this.activePath(workspaceRoot, taskId);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(indexPath), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(notificationPath), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(activePath), { recursive: true, mode: 0o700 });
    await writeFile(outputPath, "", { mode: 0o600 });
    const startedAt = now.toISOString();
    await writeJsonAtomic(taskPath, {
      schemaVersion: 2,
      taskId,
      status: "working",
      statusMessage: "Task created; command launch pending.",
      createdAt: startedAt,
      lastUpdatedAt: startedAt,
      ttlMs: taskTtlMs(),
      workspaceId: input.workspaceId,
      runId,
      command: input.command,
      cwd: input.cwd,
      root: workspaceRoot,
      outputPath,
      lastActivityAt: startedAt,
      unitName,
      outputBytes: 0,
      outputLines: 0,
    } satisfies DurableTaskState);

    const request: DurableTaskRequest = {
      schemaVersion: 2,
      taskId,
      runId,
      workspaceId: input.workspaceId,
      unitName,
      command: input.command,
      cwd: input.cwd,
      root: workspaceRoot,
      runRoot: this.runRoot,
      outputPath,
      taskPath,
      metaPath,
      notificationPath,
      activePath,
      startedAt,
      ttlMs: taskTtlMs(),
      env: taskEnvironment(input),
    };
    await writeJsonAtomic(requestPath, request);
    await writeJsonAtomic(indexPath, {
      schemaVersion: 1,
      taskId,
      workspaceId: input.workspaceId,
      runId,
      taskPath,
    });
    await writeJsonAtomic(activePath, {
      schemaVersion: 1,
      taskId,
      runId,
      root: workspaceRoot,
      taskPath,
    } satisfies DurableTaskActiveMarker);

    await this.launch({ requestPath, unitName, runnerPath: this.runnerPath });
    const deadline = Date.now() + Math.max(0, waitMs);
    let state = await readState(taskPath);
    while (runningState(state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
      state = await readState(taskPath);
    }
    return this.snapshot(state);
  }

  async get(
    workspaceRoot: string,
    taskId: string,
    options: { acknowledge?: boolean } = {},
  ): Promise<DurableTaskView> {
    let state = await this.findTask(taskId);
    this.assertOwned(state, workspaceRoot);
    state = await this.reconcileTask(state);
    const view = durableTaskView(state);
    if (options.acknowledge !== false
      && (view.status === "completed" || view.status === "cancelled" || view.status === "failed")) {
      await unlink(this.notificationPath(workspaceRoot, taskId)).catch(() => undefined);
    }
    return view;
  }

  async pendingNotifications(workspaceRoot: string): Promise<DurableTaskNotification[]> {
    await this.reconcileActiveTasks(workspaceRoot);
    const directory = path.join(this.runRoot, ".task-notifications", workspaceKey(workspaceRoot));
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const notifications: DurableTaskNotification[] = [];
    for (const entry of entries.filter((candidate) => candidate.isFile()).slice(0, 20)) {
      try {
        const parsed = JSON.parse(await readFile(path.join(directory, entry.name), "utf8")) as DurableTaskNotification & { root?: string };
        if (parsed.root && path.resolve(parsed.root) !== path.resolve(workspaceRoot)) continue;
        if (parsed.status !== "completed" && parsed.status !== "cancelled" && parsed.status !== "failed") continue;
        notifications.push(parsed);
      } catch {
        // Ignore a partially-written or stale notification file.
      }
    }
    return notifications.sort((left, right) => left.lastUpdatedAt.localeCompare(right.lastUpdatedAt));
  }

  async cancel(workspaceRoot: string, taskId: string): Promise<void> {
    const state = await this.findTask(taskId);
    this.assertOwned(state, workspaceRoot);
    if (state.status !== "working" && state.status !== "input_required") return;
    if (state.unitName && systemdUserAvailable()) {
      await execFileAsync("systemctl", ["--user", "stop", state.unitName], {
        timeout: 5_000,
        windowsHide: true,
      }).catch(() => undefined);
      return;
    }
    if (state.runnerPid) {
      try {
        process.kill(state.runnerPid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }

  async update(
    workspaceRoot: string,
    taskId: string,
    inputResponses: Record<string, unknown>,
  ): Promise<void> {
    const state = await this.findTask(taskId);
    this.assertOwned(state, workspaceRoot);
    if (state.status !== "input_required") {
      throw new Error(`Task ${taskId} is not waiting for input.`);
    }
    const outstanding = state.inputRequests ?? {};
    for (const key of Object.keys(inputResponses)) {
      if (!(key in outstanding)) continue;
      delete outstanding[key];
    }
    await this.writeTaskState(state, {
      inputRequests: outstanding,
      status: Object.keys(outstanding).length === 0 ? "working" : "input_required",
      statusMessage: Object.keys(outstanding).length === 0
        ? "Input received; task may resume."
        : "Waiting for remaining client input.",
    });
  }

  private async launch(input: DurableTaskLauncherInput): Promise<void> {
    if (this.launchOverride) {
      await this.launchOverride(input);
      return;
    }

    if (systemdUserAvailable()) {
      try {
        await execFileAsync("systemd-run", [
          "--user",
          "--collect",
          `--unit=${input.unitName}`,
          "--property=Type=exec",
          "--property=KillMode=control-group",
          "--property=TimeoutStopSec=10s",
          process.execPath,
          input.runnerPath,
          input.requestPath,
        ], { timeout: 5_000, windowsHide: true });
        return;
      } catch {
        // Fall through to a detached runner. This keeps DevSpace functional on
        // systems without a usable user systemd manager.
      }
    }

    const child = spawn(process.execPath, [input.runnerPath, input.requestPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  }

  private async findTask(taskId: string): Promise<DurableTaskState> {
    if (!/^task_[0-9a-f-]{36}$/i.test(taskId)) throw new Error("Invalid taskId.");
    try {
      const pointer = JSON.parse(await readFile(this.taskIndexPath(taskId), "utf8")) as { taskPath?: string };
      if (pointer.taskPath) return readState(this.validateTaskPath(pointer.taskPath));
    } catch {
      // Fall back to scanning runs created before the task index existed.
    }
    const days = await readdir(this.runRoot, { withFileTypes: true }).catch(() => []);
    for (const day of days.filter((entry) => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      const dayPath = path.join(this.runRoot, day.name);
      const runs = await readdir(dayPath, { withFileTypes: true }).catch(() => []);
      for (const run of runs) {
        if (!run.isDirectory()) continue;
        const taskPath = path.join(dayPath, run.name, "task.json");
        try {
          const state = await readState(taskPath);
          if (state.taskId === taskId) return state;
        } catch {
          // Ignore non-task or partially-created run directories.
        }
      }
    }
    throw new Error(`Unknown task: ${taskId}`);
  }

  private assertOwned(state: DurableTaskState, workspaceRoot: string): void {
    if (path.resolve(state.root) !== path.resolve(workspaceRoot)) {
      throw new Error(`Task ${state.taskId} does not belong to workspace root ${workspaceRoot}.`);
    }
  }

  private async writeTaskState(
    state: DurableTaskState,
    update: Partial<DurableTaskState>,
  ): Promise<void> {
    const next = {
      ...state,
      ...update,
      lastUpdatedAt: new Date().toISOString(),
    } satisfies DurableTaskState;
    const taskPath = await this.findTaskPath(state.taskId);
    await writeJsonAtomic(taskPath, next);
  }

  private async reconcileActiveTasks(workspaceRoot: string): Promise<void> {
    const directory = path.join(this.runRoot, ".task-active", workspaceKey(workspaceRoot));
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((candidate) => candidate.isFile()).slice(0, 100)) {
      const markerPath = path.join(directory, entry.name);
      try {
        const marker = JSON.parse(await readFile(markerPath, "utf8")) as DurableTaskActiveMarker;
        if (path.resolve(marker.root) !== path.resolve(workspaceRoot)) continue;
        const state = await readState(this.validateTaskPath(marker.taskPath));
        const reconciled = await this.reconcileTask(state);
        if (reconciled.status !== "working" && reconciled.status !== "input_required") {
          await unlink(markerPath).catch(() => undefined);
        }
      } catch {
        // Leave unreadable markers alone; retention or manual inspection can recover them.
      }
    }
  }

  private async reconcileTask(state: DurableTaskState): Promise<DurableTaskState> {
    if (state.status !== "working") return state;
    if (await this.runnerIsAlive(state)) return state;

    const finishedAt = new Date().toISOString();
    const message = "Task runner exited without writing a terminal task state.";
    const failed = {
      ...state,
      status: "failed" as const,
      statusMessage: message,
      lastUpdatedAt: finishedAt,
      finishedAt,
      error: {
        code: -32603,
        message,
        data: { runId: state.runId },
      },
    } satisfies DurableTaskState;
    await writeJsonAtomic(await this.findTaskPath(state.taskId), failed);
    await writeJsonAtomic(this.notificationPath(state.root, state.taskId), {
      schemaVersion: 1,
      taskId: state.taskId,
      root: state.root,
      runId: state.runId,
      status: "failed",
      statusMessage: message,
      lastUpdatedAt: finishedAt,
    });
    await unlink(this.activePath(state.root, state.taskId)).catch(() => undefined);
    return failed;
  }

  private async runnerIsAlive(state: DurableTaskState): Promise<boolean> {
    let unitKnownInactive = false;
    if (!this.launchOverride && state.unitName && systemdUserAvailable()) {
      try {
        const { stdout } = await execFileAsync(
          "systemctl",
          ["--user", "show", state.unitName, "--property=ActiveState", "--value"],
          { timeout: 1_500, windowsHide: true },
        );
        const activeState = stdout.trim();
        if (activeState === "active" || activeState === "activating" || activeState === "reloading" || activeState === "deactivating") {
          return true;
        }
        unitKnownInactive = true;
      } catch {
        // A user-manager restart or transient systemctl failure is not proof
        // that the runner died. Fall through to the runner PID/heartbeat.
      }
    }

    if (state.runnerPid) {
      try {
        process.kill(state.runnerPid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true;
        return false;
      }
    }

    if (unitKnownInactive) return false;

    const updatedAt = Date.parse(state.lastUpdatedAt);
    return !Number.isFinite(updatedAt) || Date.now() - updatedAt <= TASK_HEARTBEAT_STALE_MS;
  }

  private async findTaskPath(taskId: string): Promise<string> {
    try {
      const pointer = JSON.parse(await readFile(this.taskIndexPath(taskId), "utf8")) as { taskPath?: string };
      if (pointer.taskPath) return this.validateTaskPath(pointer.taskPath);
    } catch {
      // Fall through to the compatibility scan.
    }
    const state = await this.findTask(taskId);
    return path.join(this.runRoot, state.createdAt.slice(0, 10), state.runId, "task.json");
  }

  private taskIndexPath(taskId: string): string {
    return path.join(this.runRoot, ".task-index", `${taskId}.json`);
  }

  private notificationPath(workspaceRoot: string, taskId: string): string {
    return path.join(
      this.runRoot,
      ".task-notifications",
      workspaceKey(workspaceRoot),
      `${taskId}.json`,
    );
  }

  private activePath(workspaceRoot: string, taskId: string): string {
    return path.join(
      this.runRoot,
      ".task-active",
      workspaceKey(workspaceRoot),
      `${taskId}.json`,
    );
  }

  private validateTaskPath(candidate: string): string {
    const resolvedRoot = path.resolve(this.runRoot);
    const resolved = path.resolve(candidate);
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error("Task index points outside the run store.");
    }
    return resolved;
  }

  private async snapshot(state: DurableTaskState): Promise<ProcessSnapshot> {
    const preview = await readPreview(state.outputPath);
    const startedAt = Date.parse(state.createdAt);
    const lastActivityAt = Date.parse(state.lastActivityAt);
    const now = Date.now();
    const running = runningState(state);
    return {
      runId: state.runId,
      taskId: state.taskId,
      command: state.command,
      output: preview.output,
      outputBytes: state.outputBytes,
      outputLines: state.outputLines,
      outputTruncated: preview.truncated,
      running,
      exitCode: state.exitCode ?? undefined,
      signal: state.signal ?? undefined,
      wallTimeMs: Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0,
      idleTimeMs: Number.isFinite(lastActivityAt) ? Math.max(0, now - lastActivityAt) : 0,
    };
  }
}
