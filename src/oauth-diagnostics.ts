import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { databasePath } from "./db/client.js";

export interface OAuthDiagnosticSnapshot {
  databaseExists: boolean;
  clients: number;
  activeAccessTokens: number;
  activeRefreshTokens: number;
  activeAuthorizationCodes: number;
  soonestRefreshExpiry?: number;
}

/** Read-only; never print client IDs, token hashes, owner secrets, or token values. */
export function inspectOAuthState(stateDir: string, nowSeconds = Math.floor(Date.now() / 1000)): OAuthDiagnosticSnapshot {
  const empty: OAuthDiagnosticSnapshot = {
    databaseExists: false,
    clients: 0,
    activeAccessTokens: 0,
    activeRefreshTokens: 0,
    activeAuthorizationCodes: 0,
  };
  const path = databasePath(stateDir);
  if (!existsSync(path)) return empty;

  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    function exists(table: string): boolean {
      return Boolean(database.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table));
    }
    function count(table: "oauth_clients" | "oauth_access_tokens" | "oauth_refresh_tokens" | "oauth_authorization_codes",
      expirationColumn?: "expires_at" | "expires_at_ms"): number {
      if (!exists(table)) return 0;
      const sql = expirationColumn
        ? `select count(*) from ${table} where ${expirationColumn} >= ?`
        : `select count(*) from ${table}`;
      const cutoff = expirationColumn === "expires_at_ms" ? nowSeconds * 1000 : nowSeconds;
      return Number(database.prepare(sql).pluck().get(...(expirationColumn ? [cutoff] : [])) ?? 0);
    }
    const result: OAuthDiagnosticSnapshot = {
      databaseExists: true,
      clients: count("oauth_clients"),
      activeAccessTokens: count("oauth_access_tokens", "expires_at"),
      activeRefreshTokens: count("oauth_refresh_tokens", "expires_at"),
      activeAuthorizationCodes: count("oauth_authorization_codes", "expires_at_ms"),
    };
    if (result.activeRefreshTokens > 0) {
      const min = database.prepare(
        "select min(expires_at) from oauth_refresh_tokens where expires_at >= ?",
      ).pluck().get(nowSeconds);
      if (typeof min === "number") result.soonestRefreshExpiry = min;
    }
    return result;
  } finally {
    database.close();
  }
}
