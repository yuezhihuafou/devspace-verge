import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { maybePruneRunStore, runStoreRoot } from "./run-store.js";

export interface ProcessRunMetadata {
  schemaVersion: 1;
  runId: string;
  command: string;
  cwd: string;
  root: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  isError: boolean;
  exitCode: number | null;
  signal: string | null;
  outputBytes: number;
  outputLines: number;
  sha256: string;
  outputPath: string;
  recoveredUpstreamFullOutput: false;
  upstreamFullOutputPath: null;
}

export interface ProcessRunLoggerSnapshot {
  runId: string;
  command: string;
  outputBytes: number;
  outputLines: number;
  outputPath: string;
}

export class ProcessRunLogger {
  readonly runId: string;
  readonly command: string;
  readonly outputPath: string;
  private readonly root: string;
  private readonly cwd: string;
  private readonly workspaceRoot: string;
  private readonly startedAtMs: number;
  private readonly metaPath: string;
  private readonly fd: number;
  private readonly hash = createHash("sha256");
  private bytes = 0;
  private newlines = 0;
  private lastByte: number | null = null;
  private closed = false;

  private constructor(input: {
    runId: string;
    command: string;
    cwd: string;
    workspaceRoot: string;
    startedAtMs: number;
    root: string;
    outputPath: string;
    metaPath: string;
    fd: number;
  }) {
    this.runId = input.runId;
    this.command = input.command;
    this.cwd = input.cwd;
    this.workspaceRoot = input.workspaceRoot;
    this.startedAtMs = input.startedAtMs;
    this.root = input.root;
    this.outputPath = input.outputPath;
    this.metaPath = input.metaPath;
    this.fd = input.fd;
  }

  static async create(input: {
    command: string;
    cwd: string;
    workspaceRoot: string;
    startedAtMs?: number;
    root?: string;
  }): Promise<ProcessRunLogger> {
    const startedAtMs = input.startedAtMs ?? Date.now();
    const started = new Date(startedAtMs);
    const root = input.root ?? runStoreRoot();
    const runId = `run_${started.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
    const dayDir = path.join(root, started.toISOString().slice(0, 10));
    const runDir = path.join(dayDir, runId);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    const outputPath = path.join(runDir, "output.log");
    const metaPath = path.join(runDir, "meta.json");
    const fd = openSync(outputPath, "w", 0o600);
    return new ProcessRunLogger({
      runId,
      command: input.command,
      cwd: input.cwd,
      workspaceRoot: input.workspaceRoot,
      startedAtMs,
      root,
      outputPath,
      metaPath,
      fd,
    });
  }

  append(output: string): void {
    if (!output || this.closed) return;
    const buffer = Buffer.from(output, "utf8");
    writeSync(this.fd, buffer, 0, buffer.length);
    this.hash.update(buffer);
    this.bytes += buffer.length;
    if (buffer.length > 0) this.lastByte = buffer[buffer.length - 1] ?? null;
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] === 0x0a) this.newlines += 1;
    }
  }

  snapshot(): ProcessRunLoggerSnapshot {
    return {
      runId: this.runId,
      command: this.command,
      outputBytes: this.bytes,
      outputLines: this.bytes === 0 ? 0 : this.newlines + (this.lastByte === 0x0a ? 0 : 1),
      outputPath: this.outputPath,
    };
  }

  async finish(input: { exitCode?: number; signal?: string }): Promise<ProcessRunMetadata> {
    if (!this.closed) {
      closeSync(this.fd);
      this.closed = true;
    }
    const finishedAtMs = Date.now();
    const snap = this.snapshot();
    const meta: ProcessRunMetadata = {
      schemaVersion: 1,
      runId: this.runId,
      command: this.command,
      cwd: this.cwd,
      root: this.workspaceRoot,
      startedAt: new Date(this.startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: Math.max(0, finishedAtMs - this.startedAtMs),
      isError: input.signal !== undefined || (input.exitCode ?? 0) !== 0,
      exitCode: input.exitCode ?? null,
      signal: input.signal ?? null,
      outputBytes: snap.outputBytes,
      outputLines: snap.outputLines,
      sha256: this.hash.digest("hex"),
      outputPath: this.outputPath,
      recoveredUpstreamFullOutput: false,
      upstreamFullOutputPath: null,
    };
    await writeFile(this.metaPath, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
    try {
      await maybePruneRunStore(this.root, finishedAtMs);
    } catch {
      // Retention is best-effort and must not alter process completion semantics.
    }
    return meta;
  }
}
