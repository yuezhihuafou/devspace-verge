import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveShellCommand } from "./process-platform.js";
import { pruneRunStore } from "./compact-runtime/retention.js";

export interface DurableTaskRequest {
  schemaVersion: 1;
  taskId: string;
  runId: string;
  command: string;
  cwd: string;
  root: string;
  runRoot: string;
  outputPath: string;
  taskPath: string;
  metaPath: string;
  startedAt: string;
  env: Record<string, string>;
}

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

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function countNewlines(buffer: Buffer): number {
  let total = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) total += 1;
  }
  return total;
}

export async function runDurableTask(requestPath: string): Promise<number> {
  const request = JSON.parse(await readFile(requestPath, "utf8")) as DurableTaskRequest;
  await unlink(requestPath).catch(() => undefined);

  const startedAtMs = Date.parse(request.startedAt);
  const hash = createHash("sha256");
  let bytes = 0;
  let newlines = 0;
  let lastByte: number | null = null;
  let lastActivityAtMs = Number.isFinite(startedAtMs) ? startedAtMs : Date.now();
  let childPid: number | undefined;
  let requestedSignal: NodeJS.Signals | undefined;
  let digest: string | undefined;
  let outputEnded = false;
  let stateWriteChain = Promise.resolve();
  const output = createWriteStream(request.outputPath, { flags: "a", mode: 0o600 });

  const state = async (
    status: DurableTaskState["status"],
    extra: Partial<DurableTaskState> = {},
  ): Promise<void> => {
    const now = Date.now();
    const value = {
      schemaVersion: 1,
      taskId: request.taskId,
      runId: request.runId,
      command: request.command,
      cwd: request.cwd,
      root: request.root,
      outputPath: request.outputPath,
      status,
      startedAt: request.startedAt,
      updatedAt: new Date(now).toISOString(),
      lastActivityAt: new Date(lastActivityAtMs).toISOString(),
      runnerPid: process.pid,
      childPid,
      outputBytes: bytes,
      outputLines: bytes === 0 ? 0 : newlines + (lastByte === 0x0a ? 0 : 1),
      ...extra,
    } satisfies DurableTaskState;
    stateWriteChain = stateWriteChain.then(() => writeJsonAtomic(request.taskPath, value));
    await stateWriteChain;
  };

  const append = (chunk: Buffer): void => {
    if (chunk.length === 0 || outputEnded) return;
    output.write(chunk);
    hash.update(chunk);
    bytes += chunk.length;
    newlines += countNewlines(chunk);
    lastByte = chunk[chunk.length - 1] ?? lastByte;
    lastActivityAtMs = Date.now();
  };

  const endOutput = async (): Promise<void> => {
    if (outputEnded) return;
    outputEnded = true;
    await new Promise<void>((resolve, reject) => {
      output.end((error?: Error | null) => error ? reject(error) : resolve());
    });
  };

  const finalHash = (): string => {
    digest ??= hash.digest("hex");
    return digest;
  };

  try {
    await state("starting");
    const shell = resolveShellCommand(request.command, process.platform, request.env);
    const { spawn } = await import("node:child_process");
    const child = spawn(shell.executable, shell.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    childPid = child.pid;
    child.stdout?.on("data", (chunk: Buffer) => append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk));

    const completion = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("error", (error) => {
        append(Buffer.from(`${error.message}\n`, "utf8"));
      });
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });

    const forwardSignal = (signal: NodeJS.Signals) => {
      requestedSignal = signal;
      child.kill(signal);
    };
    const onTerm = () => forwardSignal("SIGTERM");
    const onInt = () => forwardSignal("SIGINT");
    process.once("SIGTERM", onTerm);
    process.once("SIGINT", onInt);
    await state("running");

    const heartbeat = setInterval(() => {
      void state("running").catch(() => undefined);
    }, 2_000);
    heartbeat.unref();

    const result = await completion;

    clearInterval(heartbeat);
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
    await endOutput();

    const finishedAtMs = Date.now();
    const signal = result.signal ?? requestedSignal ?? null;
    const exitCode = result.exitCode;
    const finalStatus: DurableTaskState["status"] = signal
      ? "cancelled"
      : exitCode === 0
        ? "completed"
        : "failed";
    const outputLines = bytes === 0 ? 0 : newlines + (lastByte === 0x0a ? 0 : 1);
    const meta = {
      schemaVersion: 1,
      runId: request.runId,
      command: request.command,
      cwd: request.cwd,
      root: request.root,
      startedAt: request.startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: Math.max(0, finishedAtMs - (Number.isFinite(startedAtMs) ? startedAtMs : finishedAtMs)),
      isError: Boolean(signal) || exitCode !== 0,
      exitCode,
      signal,
      outputBytes: bytes,
      outputLines,
      sha256: finalHash(),
      outputPath: request.outputPath,
      logError: null,
      recoveredUpstreamFullOutput: false,
      upstreamFullOutputPath: null,
    };
    await writeJsonAtomic(request.metaPath, meta);
    await state(finalStatus, {
      finishedAt: meta.finishedAt,
      exitCode,
      signal,
      outputBytes: bytes,
      outputLines,
    });
    await pruneRunStore({
      root: request.runRoot,
      now: finishedAtMs,
      protectRunId: request.runId,
    }).catch(() => undefined);
    return exitCode ?? (signal ? 128 : 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    append(Buffer.from(`${message}\n`, "utf8"));
    await endOutput().catch(() => undefined);
    const finishedAtMs = Date.now();
    const outputLines = bytes === 0 ? 0 : newlines + (lastByte === 0x0a ? 0 : 1);
    await writeJsonAtomic(request.metaPath, {
      schemaVersion: 1,
      runId: request.runId,
      command: request.command,
      cwd: request.cwd,
      root: request.root,
      startedAt: request.startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: Math.max(0, finishedAtMs - (Number.isFinite(startedAtMs) ? startedAtMs : finishedAtMs)),
      isError: true,
      exitCode: 1,
      signal: null,
      outputBytes: bytes,
      outputLines,
      sha256: finalHash(),
      outputPath: request.outputPath,
      logError: null,
      recoveredUpstreamFullOutput: false,
      upstreamFullOutputPath: null,
    });
    await state("failed", {
      finishedAt: new Date(finishedAtMs).toISOString(),
      exitCode: 1,
      signal: null,
      outputBytes: bytes,
      outputLines,
    }).catch(() => undefined);
    return 1;
  }
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;
  try {
    const modulePath = await realpath(fileURLToPath(import.meta.url));
    const entrypointPath = await realpath(process.argv[1]);
    return modulePath === entrypointPath;
  } catch {
    return false;
  }
}

if (await isMainModule()) {
  const requestPath = process.argv[2];
  if (!requestPath) {
    console.error("usage: durable-task-runner <request.json>");
    process.exit(2);
  }
  process.exit(await runDurableTask(requestPath));
}
