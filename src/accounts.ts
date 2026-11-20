import { open, pkcePair, randomToken, seal } from "./crypto.js";
import { clock, type Env, type Platform, type UserRef } from "./env.js";
import { McpClient } from "./mcp.js";
import {
  authorizeUrl,
  discover,
  exchangeCode,
  OAuthError,
  refresh,
  registerClient,
  revoke,
  type AuthServer,
  type Session,
} from "./oauth.js";

/**
 * Bindings between a chat user and a PopNow account, kept in KV.
 *
 * - `oauth:client`            the dynamically registered client (no secret; it is a public client)
 * - `bind:<token>`            a one-time Connect link, 15 minutes
 * - `state:<state>`           a sign-in in progress (PKCE verifier), 10 minutes
 * - `link:<platform>:<ws>:<user>`  the PopNow tokens, AES-GCM sealed with TOKEN_KEY
 */

export const BIND_TTL_SECONDS = 15 * 60;
export const STATE_TTL_SECONDS = 10 * 60;

export interface ClientRecord extends AuthServer {
  clientId: string;
  redirectUri: string;
  mcpUrl: string;
}

export interface BindRecord {
  ref: UserRef;
  /** Where to say "connected" afterwards (Slack DM), optional. */
  createdAt: number;
}

interface StateRecord {
  ref: UserRef;
  verifier: string;
  clientId: string;
}

export function linkKey(ref: UserRef): string {
  return `link:${ref.platform}:${ref.workspace}:${ref.user}`;
}

export function callbackUrl(env: Env): string {
  return `${env.PUBLIC_URL.replace(/\/$/, "")}/oauth/callback`;
}

/** The registered OAuth client, registering one the first time (or when the address changed). */
export async function ensureClient(env: Env): Promise<ClientRecord> {
  const redirectUri = callbackUrl(env);
  const saved = await env.DATA.get("oauth:client");
  if (saved) {
    const record = JSON.parse(saved) as ClientRecord;
    if (record.redirectUri === redirectUri && record.mcpUrl === env.POPNOW_MCP_URL) return record;
  }
  const server = await discover(env.POPNOW_MCP_URL);
  const clientId = await registerClient(server, redirectUri);
  const record: ClientRecord = { ...server, clientId, redirectUri, mcpUrl: env.POPNOW_MCP_URL };
  await env.DATA.put("oauth:client", JSON.stringify(record));
  return record;
}

/** A one-time Connect link for this chat user. */
export async function createBindLink(env: Env, ref: UserRef): Promise<string> {
  const token = randomToken(24);
  const record: BindRecord = { ref, createdAt: clock.now() };
  await env.DATA.put(`bind:${token}`, JSON.stringify(record), { expirationTtl: BIND_TTL_SECONDS });
  return `${env.PUBLIC_URL.replace(/\/$/, "")}/connect/${token}`;
}

export async function peekBind(env: Env, token: string): Promise<BindRecord | undefined> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return undefined;
  const saved = await env.DATA.get(`bind:${token}`);
  return saved ? (JSON.parse(saved) as BindRecord) : undefined;
}

/**
 * Uses up the Connect link and returns the PopNow sign-in address. The link works once: a second
 * use (or a forwarded copy) finds nothing.
 */
export async function startSignIn(env: Env, token: string): Promise<string | undefined> {
  const bind = await peekBind(env, token);
  if (!bind) return undefined;
  await env.DATA.delete(`bind:${token}`);
  const client = await ensureClient(env);
  const { verifier, challenge } = await pkcePair();
  const state = randomToken(24);
  const record: StateRecord = { ref: bind.ref, verifier, clientId: client.clientId };
  await env.DATA.put(`state:${state}`, JSON.stringify(record), { expirationTtl: STATE_TTL_SECONDS });
  return authorizeUrl(client, {
    clientId: client.clientId,
    redirectUri: client.redirectUri,
    state,
    challenge,
    resource: env.POPNOW_MCP_URL,
  });
}

export type CallbackOutcome =
  | { ok: true; ref: UserRef }
  | { ok: false; status: number; reason: "state" | "issuer" | "denied" | "exchange" };

/** The redirect from PopNow: checks state and issuer, swaps the code for tokens and stores them sealed. */
export async function finishSignIn(env: Env, params: URLSearchParams): Promise<CallbackOutcome> {
  const state = params.get("state") ?? "";
  const saved = /^[A-Za-z0-9_-]{20,64}$/.test(state) ? await env.DATA.get(`state:${state}`) : null;
  if (!saved) return { ok: false, status: 400, reason: "state" };
  const record = JSON.parse(saved) as StateRecord;
  const client = await ensureClient(env);
  const iss = params.get("iss");
  if (iss !== null && iss.replace(/\/$/, "") !== client.issuer.replace(/\/$/, "")) {
    // Not ours: leave the sign-in waiting for the real reply.
    return { ok: false, status: 400, reason: "issuer" };
  }
  await env.DATA.delete(`state:${state}`);
  const code = params.get("code");
  if (params.get("error") || !code) return { ok: false, status: 400, reason: "denied" };
  let session: Session;
  try {
    session = await exchangeCode(client, {
      clientId: record.clientId,
      code,
      verifier: record.verifier,
      redirectUri: client.redirectUri,
      mcpUrl: env.POPNOW_MCP_URL,
    });
  } catch (error) {
    if (error instanceof OAuthError && error.code === "invalid_client") await env.DATA.delete("oauth:client");
    return { ok: false, status: 400, reason: "exchange" };
  }
  // A new binding replaces an older one; revoke the old tokens so they don't linger.
  const previous = await readSession(env, record.ref);
  await saveSession(env, record.ref, session);
  if (previous) await revoke(previous);
  return { ok: true, ref: record.ref };
}

export async function readSession(env: Env, ref: UserRef): Promise<Session | undefined> {
  const key = linkKey(ref);
  const sealed = await env.DATA.get(key);
  if (!sealed) return undefined;
  const plain = await open(env.TOKEN_KEY, sealed, key);
  return plain ? (JSON.parse(plain) as Session) : undefined;
}

export async function saveSession(env: Env, ref: UserRef, session: Session): Promise<void> {
  const key = linkKey(ref);
  await env.DATA.put(key, await seal(env.TOKEN_KEY, JSON.stringify(session), key));
}

export async function isLinked(env: Env, ref: UserRef): Promise<boolean> {
  return (await env.DATA.get(linkKey(ref))) !== null;
}

/** Removes the binding and revokes its tokens at PopNow. */
export async function unlink(env: Env, ref: UserRef): Promise<boolean> {
  const session = await readSession(env, ref);
  await env.DATA.delete(linkKey(ref));
  if (session) await revoke(session);
  return session !== undefined;
}

/** An MCP client for this user; refreshed tokens are saved back sealed. Undefined when not bound. */
export async function clientFor(env: Env, ref: UserRef): Promise<McpClient | undefined> {
  const session = await readSession(env, ref);
  if (!session) return undefined;
  return new McpClient({
    session,
    renew: async (current) => {
      try {
        const next = await refresh(current);
        await saveSession(env, ref, next);
        return next;
      } catch (error) {
        // Another job may have refreshed (and rotated) the token a moment ago: use what it saved.
        const latest = await readSession(env, ref);
        if (latest && latest.accessToken !== current.accessToken) return latest;
        throw error;
      }
    },
  });
}

export function refOf(platform: Platform, workspace: string | undefined, user: string): UserRef {
  return { platform, workspace: workspace || "dm", user };
}
