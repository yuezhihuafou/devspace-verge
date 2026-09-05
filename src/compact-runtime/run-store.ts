import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { compactPreview } from "./output-policy.js";

export interface ShellInput {
  command: string;
  timeout?: number;
}

export interface ShellContext {
  cwd: string;
  root: string;
}

export interface ShellResponse {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

export interface ShellRunMetadata {
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
  outputBytes: number;
  outputLines: number;
  sha256: string;
  outputPath: string;
  recoveredUpstreamFullOutput: boolean;
  upstreamFullOutputPath: string | null;
}

const DEFAULT_ROOT = path.join(homedir(), ".local", "share", "devspace", "runs");
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

export function runStoreRoot(): string {
  return process.env.DEVSPACE_COMPACT_RUN_ROOT || DEFAULT_ROOT;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeIsoDate(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function textFromContent(content: ShellResponse["content"] = []): string {
  return content
    .filter((item) => item?.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

function parseExitCode(text: string, isError: boolean): number | null {
  const match = text.match(/Command exited with code\s+(\d+)/i);
  if (match) return Number.parseInt(match[1], 10);
  return isError ? null : 0;
}

function upstreamFullOutputPath(text: string): string | null {
  return text.match(/Full output:\s+(\/tmp\/pi-bash-[A-Za-z0-9._-]+\.log)/)?.[1] ?? null;
}

async function summarizeFile(filePath: string): Promise<Pick<ShellRunMetadata, "outputBytes" | "outputLines" | "sha256">> {
  const hash = createHash("sha256");
  let bytes = 0;
  let newlines = 0;
  let lastByte: number | null = null;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    bytes += chunk.length;
    if (chunk.length > 0) lastByte = chunk[chunk.length - 1] ?? null;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] === 0x0a) newlines += 1;
    }
  }
  return {
    outputBytes: bytes,
    outputLines: bytes === 0 ? 0 : newlines + (lastByte === 0x0a ? 0 : 1),
    sha256: hash.digest("hex"),
  };
}

async function persistOutputFile(modelVisibleText: string, outputPath: string): Promise<{
  recovered: boolean;
  upstreamPath: string | null;
}> {
  const upstreamPath = upstreamFullOutputPath(modelVisibleText);
  if (upstreamPath) {
    try {
      await copyFile(upstreamPath, outputPath);
      await chmod(outputPath, 0o600);
      return { recovered: true, upstreamPath };
    } catch {
      // Fall back to the bounded model-visible Pi result if the temp file vanished.
    }
  }
  await writeFile(outputPath, modelVisibleText, { mode: 0o600 });
  return { recovered: false, upstreamPath };
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

async function maybePruneRunStore(root: string, now: number): Promise<void> {
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

export async function persistShellRun({
  input,
  context,
  response,
  durationMs,
}: {
  input: ShellInput;
  context: ShellContext;
  response: ShellResponse;
  durationMs: number;
}): Promise<{
  runId: string;
  meta: ShellRunMetadata;
  compactText: string;
}> {
  const now = new Date();
  const root = runStoreRoot();
  const runId = `run_${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
  const dayDir = path.join(root, safeIsoDate(now));
  const runDir = path.join(dayDir, runId);
  await mkdir(runDir, { recursive: true, mode: 0o700 });

  const modelVisibleText = textFromContent(response.content);
  const outputPath = path.join(runDir, "output.log");
  const metaPath = path.join(runDir, "meta.json");
  const recovered = await persistOutputFile(modelVisibleText, outputPath);
  const fileSummary = await summarizeFile(outputPath);
  const exitCode = parseExitCode(modelVisibleText, Boolean(response.isError));

  const meta: ShellRunMetadata = {
    schemaVersion: 1,
    runId,
    command: input.command,
    cwd: context.cwd,
    root: context.root,
    startedAt: new Date(now.getTime() - durationMs).toISOString(),
    finishedAt: now.toISOString(),
    durationMs,
    isError: Boolean(response.isError),
    exitCode,
    ...fileSummary,
    outputPath,
    recoveredUpstreamFullOutput: recovered.recovered,
    upstreamFullOutputPath: recovered.upstreamPath,
  };

  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });

  const preview = compactPreview(modelVisibleText, Boolean(response.isError), input.command);
  const status = response.isError ? "error" : "ok";
  const lines = [
    `run=${runId} status=${status}${exitCode === null ? "" : ` exit=${exitCode}`} duration=${durationMs}ms output=${fileSummary.outputLines}L/${fileSummary.outputBytes}B`,
  ];
  if (preview) lines.push(preview);
  lines.push(`log=${runId}; more=devspace-log read ${runId} 1 80; search=devspace-log grep ${runId} <pattern>`);

  try {
    await maybePruneRunStore(root, now.getTime());
  } catch {
    // Retention is best-effort. Never emit raw output because pruning failed.
  }

  return { runId, meta, compactText: lines.join("\n") };
}
