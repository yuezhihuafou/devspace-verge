import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

test("HTTP MCP enforces canonical and exact alias bearer resources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-http-oauth-"));
  const canonical = "https://agent.example.com/mcp";
  const alias = "https://tunnel.example.com/v1/mcp/tunnel_123";
  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    server: { publicBaseUrl: "https://agent.example.com" },
    storage: { stateDir: join(root, "state") },
    workspaces: { allowedRoots: [root] },
    oauth: { allowedResourceUrls: [alias] },
    logging: { level: "silent" },
  }));
  const store = new SqliteOAuthStore(config.stateDir);
  const client = store.registerClient({
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
  }, config.oauth.allowedRedirectHosts);
  const cases = [
    { resource: canonical, accepted: true },
    { resource: alias, accepted: true },
    { resource: `${alias}/child`, accepted: false },
    { resource: `${alias}?other=1`, accepted: false },
    { resource: "https://tunnel.example.com/v1/mcp/other", accepted: false },
  ];
  for (const { resource } of cases) {
    store.saveAccessToken(createHash("sha256").update(resource).digest("base64url"), {
      clientId: client.client_id, scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600, resource,
    });
  }
  store.close();
  const running = createServer(config);
  const listener = running.app.listen(0, "127.0.0.1");
  t.after(async () => {
    await running.close();
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  for (const { resource, accepted } of cases) {
    const response: Response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resource}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "resource-test", version: "1.0.0" } },
      }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.text();
    assert.equal(response.status, accepted ? 200 : 401, `${resource}: ${body}`);
    if (accepted) assert.match(body, /"serverInfo"/);
  }
});

test("HTTP authorization code exchange and refresh survive a service restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-oauth-restart-http-"));
  const publicBaseUrl = "https://stable.example.test";
  const resource = `${publicBaseUrl}/mcp`;
  const ownerToken = "owner-token-for-http-restart-test";
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const verifier = "restart-integration-verifier-01234567890123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    server: { publicBaseUrl },
    storage: { stateDir: join(root, "state") },
    workspaces: { allowedRoots: [root] },
    logging: { level: "silent" },
  }));

  let running = createServer({ ...config, oauth: { ...config.oauth, ownerToken } });
  let listener = running.app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const baseUrl = () => {
    const addr = listener.address();
    assert.ok(addr && typeof addr !== "string");
    return `http://127.0.0.1:${addr.port}`;
  };
  const stop = async () => {
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    await running.close();
  };
  t.after(async () => {
    await stop();
    await rm(root, { recursive: true, force: true });
  });

  const registration = await fetch(`${baseUrl()}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Restart test",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201, await registration.clone().text());
  const { client_id: clientId } = await registration.json() as { client_id: string };
  assert.ok(clientId);

  const approval = await fetch(`${baseUrl()}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: "code",
      code_challenge: challenge, code_challenge_method: "S256",
      scope: "devspace", resource, state: "restart-state", owner_token: ownerToken,
    }),
  });
  assert.equal(approval.status, 302, await approval.clone().text());
  const redirect = new URL(approval.headers.get("location") ?? "");
  const code = redirect.searchParams.get("code");
  assert.ok(code);
  assert.equal(redirect.searchParams.get("state"), "restart-state");

  await stop();
  running = createServer({ ...config, oauth: { ...config.oauth, ownerToken } });
  listener = running.app.listen(0, "127.0.0.1");
  await once(listener, "listening");

  const exchange = await fetch(`${baseUrl()}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: clientId, code,
      code_verifier: verifier, redirect_uri: redirectUri, resource,
    }),
  });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const issued = await exchange.json() as { access_token: string; refresh_token: string };
  assert.ok(issued.access_token);
  assert.ok(issued.refresh_token);

  const refresh = await fetch(`${baseUrl()}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", client_id: clientId,
      refresh_token: issued.refresh_token, resource,
    }),
  });
  assert.equal(refresh.status, 200, await refresh.clone().text());
  const rotated = await refresh.json() as { access_token: string; refresh_token: string };
  assert.ok(rotated.access_token);
  assert.notEqual(rotated.refresh_token, issued.refresh_token);

  const replay = await fetch(`${baseUrl()}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", client_id: clientId,
      refresh_token: issued.refresh_token, resource,
    }),
  });
  assert.equal(replay.status, 400, await replay.clone().text());
});
