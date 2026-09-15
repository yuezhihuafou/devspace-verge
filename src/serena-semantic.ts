import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface SerenaClientLike {
  callTool(params: { name: string; arguments?: Record<string, unknown> }, resultSchema?: unknown, options?: { timeout?: number }): Promise<unknown>;
  close(): Promise<void>;
}

export interface SerenaSemanticManagerOptions {
  available?: boolean;
  createClient?: (root: string) => Promise<SerenaClientLike>;
  timeoutMs?: number;
  maxBackends?: number;
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

async function managedSerenaHome(root: string): Promise<string> {
  const digest = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 20);
  const base = process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, "devspace", "serena", digest)
    : path.join(homedir(), ".local", "share", "devspace", "serena", digest);
  const projectData = path.join(base, "project-data");
  await mkdir(projectData, { recursive: true, mode: 0o700 });
  const configPath = path.join(base, "serena_config.yml");
  try {
    await access(configPath);
  } catch {
    await writeFile(
      configPath,
      `projects: []\nproject_serena_folder_location: ${JSON.stringify(projectData)}\n`,
      { mode: 0o600 },
    );
  }
  return base;
}

async function createClient(root: string): Promise<SerenaClientLike> {
  const serenaHome = await managedSerenaHome(root);
  const transport = new StdioClientTransport({
    command: "serena",
    args: ["start-mcp-server", "--project", root, "--context", "codex", "--transport", "stdio", "--enable-web-dashboard", "false", "--open-web-dashboard", "false", "--enable-gui-log-window", "false", "--log-level", "ERROR"],
    cwd: root,
    env: Object.fromEntries(
      Object.entries({ ...process.env, SERENA_HOME: serenaHome }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    stderr: "pipe",
  });
  const client = new Client({ name: "devspace-serena-backend", version: "1" });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Serena MCP connect timeout")), 15_000);
        timer.unref();
      }),
    ]);
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return client;
}

export class SerenaSemanticManager {
  readonly available: boolean;
  private readonly clients = new Map<string, Promise<{ client: SerenaClientLike; startedAt: number }>>();
  private readonly busy = new Map<string, number>();
  private readonly factory: (root: string) => Promise<SerenaClientLike>;
  private readonly timeoutMs: number;
  private readonly maxBackends: number;

  constructor(options: SerenaSemanticManagerOptions = {}) {
    this.available = options.available ?? installed();
    this.factory = options.createClient ?? createClient;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBackends = Math.max(1, options.maxBackends ?? 4);
  }

  async call(root: string, tool: string, args: Record<string, unknown>): Promise<{ result: string; truncated: boolean; backendAgeMs: number }> {
    if (!this.available) throw new Error("Serena semantic backend is not installed.");
    const key = path.resolve(root);
    this.busy.set(key, (this.busy.get(key) ?? 0) + 1);
    let backend: { client: SerenaClientLike; startedAt: number } | undefined;
    try {
      backend = await this.backend(key);
      const response = await backend.client.callTool({ name: tool, arguments: args }, undefined, { timeout: this.timeoutMs });
      const raw = textFromResult(response);
      const truncated = raw.length > 8_000;
      const result = truncated ? `${raw.slice(0, 3_950)}\n... semantic result truncated; refine the query ...\n${raw.slice(-3_950)}` : raw;
      return { result, truncated, backendAgeMs: Math.max(0, Date.now() - backend.startedAt) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timeout/i.test(message)) throw new Error(`Serena semantic backend timed out after ${this.timeoutMs}ms; it may still be warming or indexing. Retry later or use DevSpace text tools meanwhile.`);
      if (/(connection|transport|channel|stream).*(closed|ended|reset)|\bEOF\b|ECONNRESET|EPIPE|not connected/i.test(message)) {
        this.clients.delete(key);
        await backend?.client.close().catch(() => undefined);
        throw new Error("Serena semantic backend disconnected; the next semantic call will start a fresh backend.");
      }
      throw error;
    } finally {
      const remaining = (this.busy.get(key) ?? 1) - 1;
      if (remaining > 0) this.busy.set(key, remaining);
      else this.busy.delete(key);
      await this.trimBackends();
    }
  }

  async close(): Promise<void> {
    const clients = await Promise.allSettled(this.clients.values());
    this.clients.clear();
    this.busy.clear();
    await Promise.allSettled(clients.filter((item): item is PromiseFulfilledResult<{ client: SerenaClientLike; startedAt: number }> => item.status === "fulfilled").map((item) => item.value.client.close()));
  }

  private async backend(root: string): Promise<{ client: SerenaClientLike; startedAt: number }> {
    const key = path.resolve(root);
    const existing = this.clients.get(key);
    if (existing) {
      this.clients.delete(key);
      this.clients.set(key, existing);
      return existing;
    }
    const created = this.factory(key).then((client) => ({ client, startedAt: Date.now() })).catch((error) => { this.clients.delete(key); throw error; });
    this.clients.set(key, created);
    await this.trimBackends();
    return created;
  }

  private async trimBackends(): Promise<void> {
    while (this.clients.size > this.maxBackends) {
      let candidate: string | undefined;
      for (const key of this.clients.keys()) {
        if ((this.busy.get(key) ?? 0) === 0) {
          candidate = key;
          break;
        }
      }
      if (!candidate) return;
      const backend = this.clients.get(candidate);
      this.clients.delete(candidate);
      if (!backend) continue;
      const settled = await backend.then((value) => value).catch(() => undefined);
      await settled?.client.close().catch(() => undefined);
    }
  }
}
