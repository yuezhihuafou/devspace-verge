import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectOAuthState } from "./oauth-diagnostics.js";
import { SqliteOAuthStore } from "./oauth-store.js";

test("OAuth doctor reads token counts without exposing or changing credential state", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-auth-doctor-"));
  try {
    const empty = inspectOAuthState(join(stateDir, "not-created"));
    assert.equal(empty.databaseExists, false);
    const store = new SqliteOAuthStore(stateDir);
    try {
      const client = store.registerClient({
        redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      }, ["chatgpt.com"]);
      const now = Math.floor(Date.now() / 1000);
      store.saveRefreshToken("secret-refresh-hash", {
        clientId: client.client_id,
        scopes: ["devspace"],
        expiresAt: now + 3600,
        resource: "https://mcp.example.com/mcp",
      });
      store.saveAccessToken("secret-access-hash", {
        clientId: client.client_id,
        scopes: ["devspace"],
        expiresAt: now - 1,
        resource: "https://mcp.example.com/mcp",
      });
      const snapshot = inspectOAuthState(stateDir, now);
      assert.equal(snapshot.databaseExists, true);
      assert.equal(snapshot.clients, 1);
      assert.equal(snapshot.activeRefreshTokens, 1);
      assert.equal(snapshot.activeAccessTokens, 0);
      assert.equal(snapshot.activeAuthorizationCodes, 0);
      assert.equal(snapshot.soonestRefreshExpiry, now + 3600);
      assert.ok(store.getRefreshToken("secret-refresh-hash"));
      assert.doesNotMatch(JSON.stringify(snapshot), /secret|client_id|token_hash/);
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
