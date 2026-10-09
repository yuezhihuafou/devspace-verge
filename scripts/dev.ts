import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parse } from "jsonc-parser";
import { join, resolve } from "node:path";
import spawn from "cross-spawn";

const checkoutRoot = resolve(process.cwd());
const configDir = join(checkoutRoot, ".devspace-dev", "config");
const hasConfig = existsSync(join(configDir, "config.jsonc")) || existsSync(join(configDir, "config.json"));

if (!hasConfig) {
  console.error("Development state is not initialized. Run `pnpm dev:seed` first.");
  process.exitCode = 1;
} else if (forkUsesProductionOAuthIdentity(configDir)) {
  console.error("Refusing to run a QA OAuth database fork at the production public URL.");
  console.error("A copied refresh token rotates independently and breaks ChatGPT authorization.");
  console.error("Run `pnpm dev:reset` to generate a local-only QA endpoint, leaving production tokens unchanged.");
  process.exitCode = 1;
} else {
  const child = spawn("tsx", ["watch", "--clear-screen=false", "src/cli.ts", "serve"], {
    cwd: checkoutRoot,
    env: {
      ...process.env,
      DEVSPACE_CONFIG_DIR: configDir,
    },
    stdio: "inherit",
  });

  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

function forkUsesProductionOAuthIdentity(localConfigDir: string): boolean {
  const productionConfigDir = resolve(process.env.DEVSPACE_CONFIG_DIR ?? join(homedir(), ".devspace"));
  const qaConfigPath = join(localConfigDir, "config.jsonc");
  const productionConfigPath = join(productionConfigDir, "config.jsonc");
  if (!existsSync(qaConfigPath) || !existsSync(productionConfigPath)) return false;

  const qa = parse(readFileSync(qaConfigPath, "utf8")) as Record<string, unknown>;
  const production = parse(readFileSync(productionConfigPath, "utf8")) as Record<string, unknown>;
  const qaUrl = mcpUrl(qa);
  const productionUrl = mcpUrl(production);
  const qaState = (qa.storage as { stateDir?: string } | undefined)?.stateDir;
  const productionState = (production.storage as { stateDir?: string } | undefined)?.stateDir;
  return Boolean(qaUrl && productionUrl && qaUrl === productionUrl
    && qaState && productionState && resolve(qaState) !== resolve(productionState));
}

function mcpUrl(config: Record<string, unknown>): string | undefined {
  const server = config.server as { publicBaseUrl?: string | null; host?: string; port?: number } | undefined;
  if (!server) return undefined;
  const host = server.host ?? "127.0.0.1";
  const port = server.port ?? 7676;
  const origin = server.publicBaseUrl ?? `http://${host}:${port}`;
  try {
    return new URL("/mcp", origin).href;
  } catch {
    return undefined;
  }
}
