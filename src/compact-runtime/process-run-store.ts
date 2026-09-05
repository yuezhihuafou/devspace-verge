import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { runStoreRoot } from "./run-store.js";

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

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

async function maybePrune(root: string, now: number): Promise<void> {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  let dayEntries: string[];
  try {
    dayEntries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return;
  }

  const retentionDays = positiveIntegerEnv("DEVSPACE_COMPACT_LOG_RETENTION_DAYS", DEFAULT_RETENTION_DAYS);
  const maxBytes = positiveIntegerEnv("DEVSPACE_COMPACT_LOG_MAX_BYTES", DEFAULT_MAX_BYTES);
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;

  for (const day of [...dayEntries]) {
    const dayTime = Date.parse(`${day}T00:00:00Z`);
    if (Number.isFinite(dayTime) && dayTime < cutoff) {
      await rm(path.join(root, day), { recursive: true, force: true });
      dayEntries = dayEntries.filter((item) => item !== day);
    }
  }

  let total = await directoryBytes(root);
  for (const day of dayEntries.slice(0, -1)) {
    if (total <= maxBytes) break;
    const dayPath = path.join(root, day);
    const bytes = await directoryBytes(dayPath);
    await rm(dayPath, { recursive: true, force: true });
    total -= bytes;
  }
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
      await maybePrune(this.root, finishedAtMs);
    } catch {
      // Retention is best-effort and must not alter process completion semantics.
    }
    return meta;
  }
}
