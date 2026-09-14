import { execFile, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);

interface SerenaClientLike {
  callTool(params: { name: string; arguments?: Record<string, unknown> }, resultSchema?: unknown, options?: { timeout?: number }): Promise<unknown>;
  close(): Promise<void>;
}

export interface SerenaSemanticManagerOptions {
  available?: boolean;
  createClient?: (root: string) => Promise<SerenaClientLike>;
  timeoutMs?: number;
}

function installed(): boolean {
  const result = spawnSync("serena", ["--version"], { stdio: "ignore", windowsHide: true, timeout: 2_000 });
  return !result.error && result.status === 0;
}

function textFromResult(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const value = result as { structuredContent?: { result?: unknown }; content?: Array<{ type?: string; text?: string }> };
  if (typeof value.structuredContent?.result === "string") return value.structuredContent.result;
  return (value.content ?? []).filter((item) => item.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n");
}

async function excludeLocalState(root: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: root, timeout: 2_000, windowsHide: true });
    const excludePath = path.resolve(root, stdout.trim());
    const current = await readFile(excludePath, "utf8").catch(() => "");
    if (current.split(/\r?\n/).some((line) => line.trim() === ".serena/")) return;
    await writeFile(excludePath, `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}.serena/\n`, "utf8");
  } catch {
    // Non-Git workspaces may keep Serena's local metadata in the workspace.
  }
}

async function createClient(root: string): Promise<SerenaClientLike> {
  await excludeLocalState(root);
  const transport = new StdioClientTransport({
    command: "serena",
    args: ["start-mcp-server", "--project", root, "--context", "codex", "--transport", "stdio", "--enable-web-dashboard", "false", "--open-web-dashboard", "false", "--enable-gui-log-window", "false", "--log-level", "ERROR"],
    cwd: root,
    stderr: "pipe",
  });
  const client = new Client({ name: "devspace-serena-backend", version: "1" });
  await client.connect(transport);
  return client;
}

export class SerenaSemanticManager {
  readonly available: boolean;
  private readonly clients = new Map<string, Promise<{ client: SerenaClientLike; startedAt: number }>>();
  private readonly factory: (root: string) => Promise<SerenaClientLike>;
  private readonly timeoutMs: number;

  constructor(options: SerenaSemanticManagerOptions = {}) {
    this.available = options.available ?? installed();
    this.factory = options.createClient ?? createClient;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async call(root: string, tool: string, args: Record<string, unknown>): Promise<{ result: string; truncated: boolean; backendAgeMs: number }> {
    if (!this.available) throw new Error("Serena semantic backend is not installed.");
    const backend = await this.backend(root);
    try {
      const response = await backend.client.callTool({ name: tool, arguments: args }, undefined, { timeout: this.timeoutMs });
      const raw = textFromResult(response);
      const truncated = raw.length > 8_000;
      const result = truncated ? `${raw.slice(0, 3_950)}\n... semantic result truncated; refine the query ...\n${raw.slice(-3_950)}` : raw;
      return { result, truncated, backendAgeMs: Math.max(0, Date.now() - backend.startedAt) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timeout/i.test(message)) throw new Error(`Serena semantic backend timed out after ${this.timeoutMs}ms; it may still be warming or indexing. Retry later or use DevSpace text tools meanwhile.`);
      throw error;
    }
  }

  async close(): Promise<void> {
    const clients = await Promise.allSettled(this.clients.values());
    this.clients.clear();
    await Promise.allSettled(clients.filter((item): item is PromiseFulfilledResult<{ client: SerenaClientLike; startedAt: number }> => item.status === "fulfilled").map((item) => item.value.client.close()));
  }

  private backend(root: string): Promise<{ client: SerenaClientLike; startedAt: number }> {
    const key = path.resolve(root);
    const existing = this.clients.get(key);
    if (existing) return existing;
    const created = this.factory(key).then((client) => ({ client, startedAt: Date.now() })).catch((error) => { this.clients.delete(key); throw error; });
    this.clients.set(key, created);
    return created;
  }
}
