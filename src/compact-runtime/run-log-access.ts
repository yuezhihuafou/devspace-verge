import { createReadStream } from "node:fs";
import { open, readdir, readFile } from "node:fs/promises";
import readline from "node:readline";
import path from "node:path";
import { runStoreRoot } from "./run-store.js";

const RUN_RE = /^run_[A-Za-z0-9_]+$/;
const MAX_LINES = 500;
const MAX_MATCHES = 200;
const MAX_RETURN_CHARS = 20_000;
const MAX_BYTE_READ = 32 * 1024;

async function findRunDir(runId: string): Promise<string> {
  if (!RUN_RE.test(runId)) throw new Error("invalid runId");
  const root = runStoreRoot();
  const days = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const day of days) {
    const candidate = path.join(root, day, runId);
    try {
      const entries = await readdir(candidate);
      if (entries.includes("meta.json")) return candidate;
    } catch {
      // Try the next day.
    }
  }
  throw new Error(`run not found: ${runId}`);
}

function boundedCount(value: string | undefined, fallback: number, max = MAX_LINES): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), max) : fallback;
}

function appendBounded(lines: string[], line: string, state: { chars: number }): boolean {
  if (state.chars >= MAX_RETURN_CHARS) return false;
  const remaining = MAX_RETURN_CHARS - state.chars;
  const clipped = line.length > remaining ? line.slice(0, remaining) : line;
  lines.push(clipped);
  state.chars += clipped.length + 1;
  if (clipped.length < line.length || state.chars >= MAX_RETURN_CHARS) {
    lines.push("… [model view capped; use devspace-log bytes for the raw range]");
    state.chars = MAX_RETURN_CHARS;
    return false;
  }
  return true;
}

async function streamReadLines(filePath: string, start: number, count: number): Promise<string> {
  const lines: string[] = [];
  const state = { chars: 0 };
  const input = createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const line of reader) {
      lineNo += 1;
      if (lineNo < start) continue;
      if (lineNo >= start + count) break;
      if (!appendBounded(lines, line, state)) break;
    }
  } finally {
    reader.close();
    input.destroy();
  }
  return lines.length ? lines.join("\n") : `(no lines at ${start})`;
}

async function streamTail(filePath: string, count: number): Promise<string> {
  const ring: string[] = [];
  const input = createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      ring.push(line.length > MAX_RETURN_CHARS ? `${line.slice(0, MAX_RETURN_CHARS)}…` : line);
      if (ring.length > count) ring.shift();
    }
  } finally {
    reader.close();
    input.destroy();
  }
  const state = { chars: 0 };
  const lines: string[] = [];
  for (const line of ring) {
    if (!appendBounded(lines, line, state)) break;
  }
  return lines.length ? lines.join("\n") : "(empty log)";
}

async function streamGrep(filePath: string, pattern: string): Promise<string> {
  const needle = pattern.toLowerCase();
  const matches: string[] = [];
  const state = { chars: 0 };
  const input = createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (!line.toLowerCase().includes(needle)) continue;
      if (!appendBounded(matches, line, state)) break;
      if (matches.length >= MAX_MATCHES) break;
    }
  } finally {
    reader.close();
    input.destroy();
  }
  return matches.length ? matches.join("\n") : `(no matches for ${pattern})`;
}

async function readBytes(filePath: string, offsetValue?: string, lengthValue?: string): Promise<string> {
  const offsetParsed = Number.parseInt(offsetValue ?? "0", 10);
  const lengthParsed = Number.parseInt(lengthValue ?? `${MAX_BYTE_READ}`, 10);
  const offset = Number.isFinite(offsetParsed) ? Math.max(offsetParsed, 0) : 0;
  const length = Number.isFinite(lengthParsed) ? Math.min(Math.max(lengthParsed, 1), MAX_BYTE_READ) : MAX_BYTE_READ;
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function handleRunLogCommand(command: string): Promise<string | null> {
  const parts = command.trim().split(/\s+/);
  if (parts[0] !== "devspace-log") return null;
  const action = parts[1];
  const runId = parts[2];
  if (!action || !runId) {
    throw new Error("usage: devspace-log read|tail|grep|bytes|meta <runId> ...");
  }
  const runDir = await findRunDir(runId);

  if (action === "meta") {
    return (await readFile(path.join(runDir, "meta.json"), "utf8")).trimEnd();
  }

  const outputPath = path.join(runDir, "output.log");
  if (action === "tail") return streamTail(outputPath, boundedCount(parts[3], 80));
  if (action === "read") {
    const start = boundedCount(parts[3], 1, Number.MAX_SAFE_INTEGER);
    const count = boundedCount(parts[4], 80);
    return streamReadLines(outputPath, start, count);
  }
  if (action === "grep") {
    const pattern = parts.slice(3).join(" ");
    if (!pattern) throw new Error("usage: devspace-log grep <runId> <pattern>");
    return streamGrep(outputPath, pattern);
  }
  if (action === "bytes") return readBytes(outputPath, parts[3], parts[4]);

  throw new Error(`unknown devspace-log action: ${action}`);
}
