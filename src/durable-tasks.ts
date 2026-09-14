import { execFile, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runStoreRoot } from "./compact-runtime/run-store.js";
import type { DurableTaskRequest } from "./durable-task-runner.js";
import type { ProcessSnapshot, StartCommandInput } from "./process-sessions.js";

const execFileAsync = promisify(execFile);
const DEFAULT_PREVIEW_CHARACTERS = 40_000;
const TASK_HEARTBEAT_STALE_MS = 60_000;

interface DurableTaskState {
  schemaVersion: 1;
  taskId: string;
  runId: string;
  command: string;
  cwd: string;
  root: string;
  outputPath: string;
  status: "starting" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  updatedAt: string;
  lastActivityAt: string;
  finishedAt?: string;
  runnerPid?: number;
  childPid?: number;
  outputBytes: number;
  outputLines: number;
  exitCode?: number | null;
  signal?: string | null;
}

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
  if (state.status !== "starting" && state.status !== "running") return false;
  const updatedAt = Date.parse(state.updatedAt);
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
    const taskId = runId;
    const unitName = `devspace-task-${runId}`;
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await writeFile(outputPath, "", { mode: 0o600 });
    const startedAt = now.toISOString();
    await writeJsonAtomic(taskPath, {
      schemaVersion: 1,
      taskId,
      runId,
      command: input.command,
      cwd: input.cwd,
      root: input.workspaceRoot ?? input.cwd,
      outputPath,
      status: "starting",
      startedAt,
      updatedAt: startedAt,
      lastActivityAt: startedAt,
      outputBytes: 0,
      outputLines: 0,
    } satisfies DurableTaskState);

    const request: DurableTaskRequest = {
      schemaVersion: 1,
      taskId,
      runId,
      command: input.command,
      cwd: input.cwd,
      root: input.workspaceRoot ?? input.cwd,
      runRoot: this.runRoot,
      outputPath,
      taskPath,
      metaPath,
      startedAt,
      env: taskEnvironment(input),
    };
    await writeJsonAtomic(requestPath, request);

    await this.launch({ requestPath, unitName, runnerPath: this.runnerPath });
    const deadline = Date.now() + Math.max(0, waitMs);
    let state = await readState(taskPath);
    while (runningState(state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
      state = await readState(taskPath);
    }
    return this.snapshot(state);
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

  private async snapshot(state: DurableTaskState): Promise<ProcessSnapshot> {
    const preview = await readPreview(state.outputPath);
    const startedAt = Date.parse(state.startedAt);
    const lastActivityAt = Date.parse(state.lastActivityAt);
    const now = Date.now();
    const running = runningState(state);
    return {
      runId: state.runId,
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
