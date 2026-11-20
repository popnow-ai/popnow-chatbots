import { clock } from "./env.js";

/**
 * The Worker is a public OAuth 2.1 client of PopNow: authorization code with PKCE (S256), a
 * dynamically registered client and the redirect https://bots.popnow.ai/oauth/callback. The same
 * flow as popnow-cli's src/account/oauth.ts, on fetch and WebCrypto instead of Node.
 */

export const SCOPES = "generate read";
const CLIENT_NAME = "PopNow for Discord and Slack";

export interface AuthServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint?: string;
}

/** The PopNow tokens of one bound chat user. Kept in KV only encrypted, never logged. */
export interface Session {
  issuer: string;
  mcpUrl: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  /** Unix milliseconds. */
  expiresAt?: number;
  scope?: string;
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${new URL(url).pathname} answered ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`the sign-in server did not return ${what}`);
  return value;
}

function isLoopback(url: URL): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

/** Only https, except a server on this computer (local testing). */
export function requireSecure(raw: string, what: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
    throw new Error(`${what} must use https: ${url.origin}`);
  }
  return url;
}

const trimSlash = (value: string): string => value.replace(/\/$/, "");

/** Finds the authorization server from the MCP endpoint's protected-resource metadata (RFC 9728). */
export async function discover(mcpUrl: string): Promise<AuthServer> {
  const mcp = requireSecure(mcpUrl, "the PopNow server");
  const resourceMeta = await getJson(
    `${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname === "/" ? "" : mcp.pathname}`,
  );
  const servers = resourceMeta.authorization_servers;
  const issuer = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : mcp.origin;
  requireSecure(issuer, "the sign-in server");
  const meta = await getJson(`${trimSlash(issuer)}/.well-known/oauth-authorization-server`);
  const declared = str(meta.issuer, "an issuer");
  if (trimSlash(declared) !== trimSlash(issuer)) {
    throw new Error("the sign-in server's metadata does not match it (issuer mismatch)");
  }
  for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
    requireSecure(str(meta[key], key.replace(/_/g, " ")), "the sign-in server");
  }
  const revocation = meta.revocation_endpoint;
  if (typeof revocation === "string") requireSecure(revocation, "the sign-in server");
  return {
    issuer: declared,
    authorizationEndpoint: str(meta.authorization_endpoint, "an authorization endpoint"),
    tokenEndpoint: str(meta.token_endpoint, "a token endpoint"),
    registrationEndpoint: str(meta.registration_endpoint, "a registration endpoint"),
    ...(typeof revocation === "string" ? { revocationEndpoint: revocation } : {}),
  };
}

export async function registerClient(server: AuthServer, redirectUri: string): Promise<string> {
  const response = await fetch(server.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      client_uri: "https://popnow.ai",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPES,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`client registration failed (${response.status})`);
  return str(((await response.json()) as Record<string, unknown>).client_id, "a client id");
}

export function authorizeUrl(
  server: AuthServer,
  options: { clientId: string; redirectUri: string; state: string; challenge: string; resource: string },
): string {
  const url = new URL(server.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", options.resource);
  return url.toString();
}

interface TokenReply {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
}

export class OAuthError extends Error {
  constructor(readonly code: string) {
    super(`the sign-in server refused the request (${code})`);
    this.name = "OAuthError";
  }
}

async function tokenRequest(endpoint: string, form: Record<string, string>): Promise<TokenReply> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const reply = (await response.json().catch(() => ({}))) as TokenReply;
  if (!response.ok || typeof reply.access_token !== "string") {
    throw new OAuthError(typeof reply.error === "string" ? reply.error : String(response.status));
  }
  return reply;
}

function sessionFrom(reply: TokenReply, base: Omit<Session, "accessToken">): Session {
  const expiresIn = typeof reply.expires_in === "number" ? reply.expires_in : undefined;
  const { expiresAt: _old, ...rest } = base;
  return {
    ...rest,
    accessToken: reply.access_token as string,
    ...(typeof reply.refresh_token === "string"
      ? { refreshToken: reply.refresh_token }
      : base.refreshToken === undefined
        ? {}
        : { refreshToken: base.refreshToken }),
    ...(expiresIn === undefined ? {} : { expiresAt: clock.now() + expiresIn * 1000 }),
    ...(typeof reply.scope === "string" ? { scope: reply.scope } : {}),
  };
}

export async function exchangeCode(
  server: AuthServer,
  options: { clientId: string; code: string; verifier: string; redirectUri: string; mcpUrl: string },
): Promise<Session> {
  const reply = await tokenRequest(server.tokenEndpoint, {
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    code_verifier: options.verifier,
    resource: options.mcpUrl,
  });
  return sessionFrom(reply, {
    issuer: server.issuer,
    mcpUrl: options.mcpUrl,
    tokenEndpoint: server.tokenEndpoint,
    ...(server.revocationEndpoint === undefined ? {} : { revocationEndpoint: server.revocationEndpoint }),
    clientId: options.clientId,
  });
}

/** Uses the refresh token; throws when there is none or the server refuses it. */
export async function refresh(session: Session): Promise<Session> {
  if (!session.refreshToken) throw new OAuthError("no_refresh_token");
  const reply = await tokenRequest(session.tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    client_id: session.clientId,
    resource: session.mcpUrl,
  });
  const { accessToken: _old, ...base } = session;
  return sessionFrom(reply, base);
}

/** Best effort: a failed revocation never keeps a binding in place. */
export async function revoke(session: Session): Promise<boolean> {
  if (!session.revocationEndpoint) return false;
  let ok = true;
  for (const [token, hint] of [
    [session.refreshToken, "refresh_token"],
    [session.accessToken, "access_token"],
  ] as const) {
    if (!token) continue;
    try {
      const response = await fetch(session.revocationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, token_type_hint: hint, client_id: session.clientId }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
      ok &&= response.ok;
    } catch {
      ok = false;
    }
  }
  return ok;
}
