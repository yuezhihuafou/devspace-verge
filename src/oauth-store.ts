import { randomUUID } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

export interface PersistedAccessTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface PersistedRefreshTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface PersistedAuthorizationCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAtMs: number;
}

export interface PersistedTokenPair {
  accessTokenHash: string;
  accessToken: PersistedAccessTokenRecord;
  refreshTokenHash: string;
  refreshToken: PersistedRefreshTokenRecord;
}

function redirectHostAllowed(redirectUri: string, allowedHosts: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }

  if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return true;
  return allowedHosts.includes(parsed.hostname);
}

export class SqliteOAuthStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
    this.deleteExpiredTokens(Math.floor(Date.now() / 1000));
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.database.sqlite
      .prepare("select client_json from oauth_clients where client_id = ?")
      .get(clientId) as { client_json: string } | undefined;

    return row ? (JSON.parse(row.client_json) as OAuthClientInformationFull) : undefined;
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
    allowedRedirectHosts: string[],
  ): OAuthClientInformationFull {
    if (!client.redirect_uris.every((uri) => redirectHostAllowed(String(uri), allowedRedirectHosts))) {
      throw new InvalidRequestError("Client redirect_uri is not allowed for this DevSpace server");
    }

    const now = Math.floor(Date.now() / 1000);
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: `devspace-${randomUUID()}`,
      client_id_issued_at: now,
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? "none",
      grant_types: client.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: client.response_types ?? ["code"],
    };

    this.database.sqlite
      .prepare("insert into oauth_clients (client_id, client_json, issued_at) values (?, ?, ?)")
      .run(registered.client_id, JSON.stringify(registered), now);

    return registered;
  }

  saveAuthorizationCode(codeHash: string, record: PersistedAuthorizationCodeRecord): void {
    this.database.sqlite
      .prepare("insert into oauth_authorization_codes (code_hash, client_id, redirect_uri, code_challenge, scopes_json, resource, expires_at_ms) values (?, ?, ?, ?, ?, ?, ?)")
      .run(codeHash, record.clientId, record.redirectUri, record.codeChallenge,
        JSON.stringify(record.scopes), record.resource ?? null, record.expiresAtMs);
  }

  getAuthorizationCode(codeHash: string): PersistedAuthorizationCodeRecord | undefined {
    const row = this.database.sqlite
      .prepare("select client_id, redirect_uri, code_challenge, scopes_json, resource, expires_at_ms from oauth_authorization_codes where code_hash = ?")
      .get(codeHash) as {
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        scopes_json: string;
        resource: string | null;
        expires_at_ms: number;
      } | undefined;
    return row ? {
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      scopes: JSON.parse(row.scopes_json) as string[],
      resource: row.resource ?? undefined,
      expiresAtMs: row.expires_at_ms,
    } : undefined;
  }

  consumeAuthorizationCode(codeHash: string): PersistedAuthorizationCodeRecord | undefined {
    const consume = this.database.sqlite.transaction(() => {
      const record = this.getAuthorizationCode(codeHash);
      if (!record || record.expiresAtMs < Date.now()) return undefined;
      const deleted = this.database.sqlite
        .prepare("delete from oauth_authorization_codes where code_hash = ?").run(codeHash);
      return deleted.changes === 1 ? record : undefined;
    });
    return consume.immediate();
  }

  saveAccessToken(tokenHash: string, record: PersistedAccessTokenRecord): void {
    this.database.sqlite
      .prepare(
        `insert into oauth_access_tokens (token_hash, client_id, scopes_json, expires_at, resource)
         values (?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           client_id = excluded.client_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource`,
      )
      .run(
        tokenHash,
        record.clientId,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.resource ?? null,
      );
  }

  getAccessToken(tokenHash: string): PersistedAccessTokenRecord | undefined {
    const row = this.database.sqlite
      .prepare(
        "select client_id, scopes_json, expires_at, resource from oauth_access_tokens where token_hash = ?",
      )
      .get(tokenHash) as
      | {
          client_id: string;
          scopes_json: string;
          expires_at: number;
          resource: string | null;
        }
      | undefined;

    return row ? rowToAccessTokenRecord(row) : undefined;
  }

  deleteAccessToken(tokenHash: string): void {
    this.database.sqlite.prepare("delete from oauth_access_tokens where token_hash = ?").run(tokenHash);
  }

  saveRefreshToken(tokenHash: string, record: PersistedRefreshTokenRecord): void {
    this.database.sqlite
      .prepare(
        `insert into oauth_refresh_tokens (token_hash, client_id, scopes_json, expires_at, resource)
         values (?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           client_id = excluded.client_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource`,
      )
      .run(
        tokenHash,
        record.clientId,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.resource ?? null,
      );
  }

  saveTokenPair(pair: PersistedTokenPair, consumedRefreshTokenHash?: string): boolean {
    const save = this.database.sqlite.transaction(() => {
      if (consumedRefreshTokenHash) {
        const result = this.database.sqlite
          .prepare("delete from oauth_refresh_tokens where token_hash = ?")
          .run(consumedRefreshTokenHash);
        if (result.changes !== 1) return false;
      }

      this.saveAccessToken(pair.accessTokenHash, pair.accessToken);
      this.saveRefreshToken(pair.refreshTokenHash, pair.refreshToken);
      return true;
    });

    return save.immediate();
  }

  getRefreshToken(tokenHash: string): PersistedRefreshTokenRecord | undefined {
    const row = this.database.sqlite
      .prepare(
        "select client_id, scopes_json, expires_at, resource from oauth_refresh_tokens where token_hash = ?",
      )
      .get(tokenHash) as
      | {
          client_id: string;
          scopes_json: string;
          expires_at: number;
          resource: string | null;
        }
      | undefined;

    return row ? rowToRefreshTokenRecord(row) : undefined;
  }

  deleteRefreshToken(tokenHash: string): void {
    this.database.sqlite.prepare("delete from oauth_refresh_tokens where token_hash = ?").run(tokenHash);
  }

  close(): void {
    this.database.close();
  }

  private deleteExpiredTokens(nowSeconds: number): void {
    this.database.sqlite.prepare("delete from oauth_access_tokens where expires_at < ?").run(nowSeconds);
    this.database.sqlite.prepare("delete from oauth_refresh_tokens where expires_at < ?").run(nowSeconds);
    this.database.sqlite.prepare("delete from oauth_authorization_codes where expires_at_ms < ?").run(nowSeconds * 1000);
  }
}

export class SqliteOAuthClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private readonly store: SqliteOAuthStore,
    private readonly allowedRedirectHosts: string[],
    private readonly onUnknownClient?: () => void,
  ) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const client = this.store.getClient(clientId);
    if (!client) this.onUnknownClient?.();
    return client;
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    return this.store.registerClient(client, this.allowedRedirectHosts);
  }
}

function rowToAccessTokenRecord(row: {
  client_id: string;
  scopes_json: string;
  expires_at: number;
  resource: string | null;
}): PersistedAccessTokenRecord {
  return {
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    resource: row.resource ?? undefined,
  };
}

function rowToRefreshTokenRecord(row: {
  client_id: string;
  scopes_json: string;
  expires_at: number;
  resource: string | null;
}): PersistedRefreshTokenRecord {
  return {
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    resource: row.resource ?? undefined,
  };
}
