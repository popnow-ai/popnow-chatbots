/**
 * The Cloudflare bindings this Worker uses, typed by hand so the Worker needs no runtime libraries.
 * Only the methods we call are listed.
 */

export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStub {
  fetch(input: Request): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  /** Bindings, quotes, one-time links, dedupe marks and the registered OAuth client. */
  DATA: KV;
  /** One Durable Object per quote: it starts the job once and follows it to the end. */
  JOBS: DurableObjectNamespace;

  /** Where this Worker is served, for example https://bots.popnow.ai. */
  PUBLIC_URL: string;
  /** The PopNow account MCP endpoint (the OAuth resource), https://api.popnow.ai/mcp. */
  POPNOW_MCP_URL: string;
  /** Secret: 32 random bytes, base64. Encrypts the PopNow tokens kept in KV (AES-GCM). */
  TOKEN_KEY: string;

  DISCORD_APPLICATION_ID?: string;
  /** Secret: the Discord application's public key (hex), for Ed25519 request signatures. */
  DISCORD_PUBLIC_KEY?: string;
  /** Secret: the bot token, used only when a reply can no longer go through the interaction token. */
  DISCORD_BOT_TOKEN?: string;

  /** Secret: Slack signing secret (v0 HMAC). */
  SLACK_SIGNING_SECRET?: string;
  SLACK_CLIENT_ID?: string;
  /** Secret: for installing the app into other workspaces (OAuth v2). */
  SLACK_CLIENT_SECRET?: string;
  /** Secret, optional: a bot token for a single workspace install, used when the team has none stored. */
  SLACK_BOT_TOKEN?: string;
}

/** A replaceable clock, so tests can move time. */
export const clock = { now: (): number => Date.now() };

export type Platform = "discord" | "slack";

/** Who a binding belongs to: one PopNow account per platform user in one server or workspace. */
export interface UserRef {
  platform: Platform;
  /** Discord server id ("dm" outside a server), or Slack team id. */
  workspace: string;
  user: string;
}

export function sameUser(a: UserRef, b: UserRef): boolean {
  return a.platform === b.platform && a.workspace === b.workspace && a.user === b.user;
}

/** A setting that was filled in (wrangler.toml ships placeholders that start with REPLACE_). */
export function configured(value: string | undefined): value is string {
  return Boolean(value) && !value!.startsWith("REPLACE_");
}
