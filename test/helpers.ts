import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { b64url, hmacSha256Hex } from "../src/crypto.js";
import {
  clock,
  type DurableObjectId,
  type DurableObjectNamespace,
  type DurableObjectState,
  type DurableObjectStorage,
  type DurableObjectStub,
  type Env,
  type ExecutionContext,
  type KV,
} from "../src/env.js";
import { handle, PopNowJob } from "../src/index.js";

// ── Time ─────────────────────────────────────────────────────────────────────────────────────

export const time = { now: 1_800_000_000_000 };
clock.now = () => time.now;

// ── KV and Durable Objects in memory ─────────────────────────────────────────────────────────

export class MemoryKV implements KV {
  data = new Map<string, { value: string; expires: number }>();
  async get(key: string): Promise<string | null> {
    const hit = this.data.get(key);
    if (!hit || hit.expires <= time.now) return null;
    return hit.value;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.data.set(key, { value, expires: time.now + (options?.expirationTtl ?? 1e9) * 1000 });
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

class MemoryStorage implements DurableObjectStorage {
  values = new Map<string, unknown>();
  alarm: number | undefined;
  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }
  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
  async setAlarm(at: number): Promise<void> {
    this.alarm = at;
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = undefined;
  }
}

class MemoryState implements DurableObjectState {
  storage = new MemoryStorage();
  private chain: Promise<unknown> = Promise.resolve();
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const run = this.chain.then(callback, callback);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

export class MemoryJobs implements DurableObjectNamespace {
  objects = new Map<string, { state: MemoryState; job: PopNowJob }>();
  env!: Env;
  idFromName(name: string): DurableObjectId {
    return { toString: () => name };
  }
  get(id: DurableObjectId): DurableObjectStub {
    const name = id.toString();
    let entry = this.objects.get(name);
    if (!entry) {
      const state = new MemoryState();
      entry = { state, job: new PopNowJob(state, this.env) };
      this.objects.set(name, entry);
    }
    const job = entry.job;
    return { fetch: (request: Request) => job.fetch(request) };
  }
  /** Runs alarms that are due within `ms` from now, in time order, moving the clock as it goes. */
  async runDue(ms = 5_000): Promise<number> {
    const limit = time.now + ms;
    let ran = 0;
    for (;;) {
      let next: { at: number; entry: { state: MemoryState; job: PopNowJob } } | undefined;
      for (const entry of this.objects.values()) {
        const at = entry.state.storage.alarm;
        if (at !== undefined && at <= limit && (!next || at < next.at)) next = { at, entry };
      }
      if (!next) return ran;
      time.now = Math.max(time.now, next.at);
      next.entry.state.storage.alarm = undefined;
      await next.entry.job.alarm();
      ran++;
      if (ran > 50) throw new Error("alarm loop");
    }
  }
  record(id: string): Record<string, unknown> | undefined {
    return this.objects.get(id)?.state.storage.values.get("job") as Record<string, unknown> | undefined;
  }
}

export class Ctx implements ExecutionContext {
  pending: Promise<unknown>[] = [];
  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }
  async settle(): Promise<void> {
    while (this.pending.length) {
      const batch = this.pending.splice(0);
      await Promise.all(batch);
    }
  }
}

// ── Fake PopNow (OAuth, MCP, upload windows, files) on 127.0.0.1 ─────────────────────────────

export interface Call {
  method: string;
  name?: string;
  args?: Record<string, unknown>;
  auth?: string;
}

export interface FakePopNow {
  origin: string;
  server: Server;
  calls: Call[];
  /** Price in credits per tool. */
  prices: Record<string, number>;
  balance: number;
  /** Credits taken by jobs that were started. */
  charged: number;
  jobs: Map<string, { tool: string; credits: number; polls: number; files: { url: string; type: string; popnow_link: string }[] }>;
  tokens: { issued: number; refreshed: number; revoked: string[]; valid: Set<string> };
  registered: { redirect_uris: string[]; token_endpoint_auth_method: string; scope: string }[];
  uploads: string[];
  /** Answer MCP as an event stream (true) or as plain JSON (false). */
  sse: boolean;
  /** When set, the next MCP request with this access token gets a 401 once. */
  expire?: string | undefined;
  /** Tools that ask for consent until called with consent: true. */
  consent: Set<string>;
  /** When the price changed, answer the creation tool with text only (no structured data), as /mcp does. */
  textOnlyPriceChange: boolean;
}

function body(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
export const BIG = 26 * 1024 * 1024;

export async function startPopNow(): Promise<FakePopNow> {
  const fake: FakePopNow = {
    origin: "",
    server: createServer(),
    calls: [],
    prices: { create_image: 48, create_video: 185, edit_image: 48, apply_effect: 125, remove_background: 10, upscale: 20 },
    balance: 5000,
    charged: 0,
    jobs: new Map(),
    tokens: { issued: 0, refreshed: 0, revoked: [], valid: new Set<string>() },
    registered: [],
    uploads: [],
    sse: true,
    consent: new Set(),
    textOnlyPriceChange: false,
  };
  const codes = new Map<string, string>();
  fake.server.on("request", async (request, response) => {
    const url = new URL(request.url ?? "/", fake.origin);
    const json = (status: number, value: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    };
    const path = url.pathname;
    if (path === "/.well-known/oauth-protected-resource/mcp") {
      json(200, { resource: `${fake.origin}/mcp`, authorization_servers: [fake.origin] });
    } else if (path === "/.well-known/oauth-authorization-server") {
      json(200, {
        issuer: fake.origin,
        authorization_endpoint: `${fake.origin}/oauth/authorize`,
        token_endpoint: `${fake.origin}/oauth/token`,
        registration_endpoint: `${fake.origin}/oauth/register`,
        revocation_endpoint: `${fake.origin}/oauth/revoke`,
      });
    } else if (path === "/oauth/register") {
      const reg = JSON.parse(await body(request)) as FakePopNow["registered"][number];
      fake.registered.push(reg);
      json(201, { client_id: "pnc_bots", redirect_uris: reg.redirect_uris });
    } else if (path === "/oauth/authorize") {
      const p = url.searchParams;
      if (p.get("code_challenge_method") !== "S256" || p.get("resource") !== `${fake.origin}/mcp` || p.get("scope") !== "generate read") {
        json(400, { error: "invalid_request" });
        return;
      }
      const code = `code-${codes.size + 1}`;
      codes.set(code, p.get("code_challenge") ?? "");
      const back = new URL(p.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", p.get("state") ?? "");
      back.searchParams.set("iss", fake.origin);
      response.writeHead(302, { location: back.toString() }).end();
    } else if (path === "/oauth/token") {
      const form = new URLSearchParams(await body(request));
      if (form.get("grant_type") === "authorization_code") {
        const challenge = codes.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const digest = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
        if (!challenge || digest !== challenge) {
          json(400, { error: "invalid_grant" });
          return;
        }
        codes.delete(form.get("code") ?? "");
        fake.tokens.issued++;
        fake.tokens.valid.add(`at-${fake.tokens.issued}`);
        json(200, { access_token: `at-${fake.tokens.issued}`, refresh_token: `rt-${fake.tokens.issued}`, expires_in: 3600, scope: "generate read" });
      } else if (form.get("grant_type") === "refresh_token" && form.get("refresh_token")?.startsWith("rt-")) {
        fake.tokens.refreshed++;
        fake.tokens.valid.add(`at-r${fake.tokens.refreshed}`);
        json(200, { access_token: `at-r${fake.tokens.refreshed}`, expires_in: 3600 });
      } else {
        json(400, { error: "invalid_grant" });
      }
    } else if (path === "/oauth/revoke") {
      const token = new URLSearchParams(await body(request)).get("token") ?? "";
      fake.tokens.revoked.push(token);
      fake.tokens.valid.delete(token);
      response.writeHead(200).end();
    } else if (path.startsWith("/console/v1/upload-sessions/tok123")) {
      const rest = path.slice("/console/v1/upload-sessions/tok123".length);
      const sent = await body(request);
      fake.uploads.push(`${request.method} ${rest}`);
      if (request.headers.authorization) fake.uploads.push("AUTH-LEAK");
      if (rest === "/files") {
        const req = JSON.parse(sent) as { name: string; bytes: number; contentType: string };
        fake.uploads.push(`file ${req.name}:${req.bytes}:${req.contentType}`);
        json(200, { code: 200, data: { fileId: "f1", uploadUrl: `${fake.origin}/put/f1`, method: "PUT", headers: { "content-type": req.contentType } } });
      } else {
        json(200, { code: 200, data: { state: rest === "/close" ? "closed" : "open" } });
      }
    } else if (path.startsWith("/put/")) {
      fake.uploads.push(`PUT ${path}:${(await body(request)).length}${request.headers.authorization ? ":AUTH-LEAK" : ""}`);
      response.writeHead(200).end();
    } else if (path === "/files/photo.png" || path === "/out/result.png") {
      response.writeHead(200, { "content-type": "image/png", "content-length": String(PNG.length) }).end(PNG);
    } else if (path === "/out/big.mp4") {
      response.writeHead(200, { "content-type": "video/mp4", "content-length": String(BIG) });
      response.end(Buffer.alloc(BIG));
    } else if (path === "/mcp") {
      await mcp(fake, request, response);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  fake.origin = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  return fake;
}

async function mcp(fake: FakePopNow, request: IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
  const auth = request.headers.authorization ?? "";
  if (fake.expire && auth === `Bearer ${fake.expire}`) {
    fake.expire = undefined;
    response.writeHead(401).end();
    return;
  }
  if (!fake.tokens.valid.has(auth.replace(/^Bearer /, ""))) {
    response.writeHead(401).end();
    return;
  }
  const message = JSON.parse(await body(request)) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  fake.calls.push({ method: message.method, auth, ...(name ? { name } : {}), ...(message.params?.arguments ? { args } : {}) });
  if (message.id === undefined) {
    response.writeHead(202).end();
    return;
  }
  const text = (t: string) => [{ type: "text", text: t }];
  let result: unknown = {};
  if (message.method === "initialize") {
    result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "popnow", version: "test" } };
  } else if (name === "estimate_cost") {
    const tool = String(args.tool);
    const credits = fake.prices[tool] ?? 0;
    result = { content: text(`${tool} would cost about ${credits} credits.`), structuredContent: { currency: "credits", credits, balance: fake.balance, steps: [credits] } };
  } else if (name === "check_balance") {
    result = { content: text(`You have ${fake.balance} PopNow credits.`), structuredContent: { currency: "credits", credits: fake.balance, held: 0 } };
  } else if (name === "list_my_creations") {
    result = { content: text("Your latest 1 creations:\n- Nov 21 · image · Nano Banana 2.1 · succeeded") };
  } else if (name === "list_presets") {
    result = {
      content: text("Video effects (apply_effect with a photo):\n- Tiny Planet (tiny-planet): the world curls into a ball\n- Zombie Turn (zombie-turn): green skin, slow walk"),
      structuredContent: { effects: ["tiny-planet", "zombie-turn"] },
    };
  } else if (name === "request_upload") {
    result = { content: text("Upload page ready."), structuredContent: { upload_id: "up_1", url: `${fake.origin}/upload/tok123` } };
  } else if (name === "get_upload") {
    result = { content: text("1 file uploaded."), structuredContent: { upload_id: "up_1", files: [{ popnow_link: "popnow://f/abc", name: "photo.png", type: "image/png" }] } };
  } else if (name === "get_job") {
    const job = fake.jobs.get(String(args.job_id));
    if (!job) {
      result = { content: text("No such job."), isError: true };
    } else {
      job.polls++;
      const done = job.polls >= 2;
      result = {
        content: text(done ? "Done! Your creation is ready." : "Still making it."),
        structuredContent: { job_id: args.job_id, status: done ? "succeeded" : "running", credits: job.credits, ...(done ? { files: job.files } : {}) },
      };
    }
  } else if (name && name in fake.prices) {
    const price = fake.prices[name] as number;
    const cap = typeof args.max_credits === "number" ? args.max_credits : undefined;
    if (fake.consent.has(name) && args.consent !== true) {
      result = { content: text("Ask the user to confirm the people in the photo."), structuredContent: { needs_consent: true } };
    } else if ((cap === undefined && price >= 300) || (cap !== undefined && cap < price)) {
      result = fake.textOnlyPriceChange && cap !== undefined
        ? { content: text(`Not started: the price is now ${price} credits, more than the ${cap} the user agreed to. Nothing was charged.`) }
        : { content: text(`Needs confirmation: ${price} credits.`), structuredContent: { currency: "credits", needs_confirmation: true, ...(cap === undefined ? {} : { price_changed: true }), credits: price, balance: fake.balance } };
    } else {
      // Like the real server, a small job without max_credits would start right away: the bot must never rely on that.
      const id = `job_${fake.jobs.size + 1}`;
      const big = name === "create_video" || name === "apply_effect";
      fake.jobs.set(id, {
        tool: name,
        credits: price,
        polls: 0,
        files: [{ url: `${fake.origin}/out/${big ? "big.mp4" : "result.png"}`, type: big ? "video/mp4" : "image/png", popnow_link: `popnow://g/${id}` }],
      });
      fake.charged += price;
      fake.balance -= price;
      result = { content: text("Started."), structuredContent: { job_id: id, status: "running", credits: price, currency: "credits" } };
    }
  }
  const reply = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
  if (fake.sse) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`event: message\ndata: ${reply}\n\n`);
  } else {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(reply);
  }
}

// ── Discord and Slack APIs, recorded ─────────────────────────────────────────────────────────

export interface PlatformCall {
  method: string;
  url: string;
  json?: Record<string, unknown>;
  form?: Record<string, string>;
  files?: string[];
  auth?: string;
}

export function stubPlatforms(): { calls: PlatformCall[]; restore: () => void; failChannelPost: { value: boolean } } {
  const real = globalThis.fetch;
  const calls: PlatformCall[] = [];
  const failChannelPost = { value: false };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!["discord.com", "slack.com", "hooks.slack.com", "files.slack.com"].includes(url.hostname)) return real(input, init);
    const call: PlatformCall = { method: init?.method ?? "GET", url: url.href };
    const headers = new Headers(init?.headers);
    if (headers.get("authorization")) call.auth = headers.get("authorization") as string;
    const b = init?.body;
    if (b instanceof FormData) {
      const payload = b.get("payload_json");
      if (typeof payload === "string") call.json = JSON.parse(payload) as Record<string, unknown>;
      call.files = [...b.keys()].filter((k) => k.startsWith("files["));
    } else if (typeof b === "string") {
      if ((headers.get("content-type") ?? "").includes("json")) call.json = JSON.parse(b) as Record<string, unknown>;
      else call.form = Object.fromEntries(new URLSearchParams(b));
    }
    calls.push(call);
    const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (url.hostname === "discord.com") {
      if (call.method === "PATCH") return reply({ id: "m1", channel_id: "c1" });
      return reply({ id: `m${calls.length}` });
    }
    if (url.hostname === "slack.com") {
      const method = url.pathname.replace("/api/", "");
      if (method === "chat.postMessage") return failChannelPost.value ? reply({ ok: false, error: "not_in_channel" }) : reply({ ok: true, ts: "1700.0001" });
      if (method === "files.getUploadURLExternal") return reply({ ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F1" });
      if (method === "conversations.open") return reply({ ok: true, channel: { id: "D1" } });
      if (method === "oauth.v2.access") return reply({ ok: true, access_token: "xoxb-installed", team: { id: "T9" } });
      return reply({ ok: true });
    }
    if (url.hostname === "files.slack.com" && url.pathname.startsWith("/files-pri/")) {
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png", "content-length": String(PNG.length) } });
    }
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real), failChannelPost };
}

// ── Environment and signing ──────────────────────────────────────────────────────────────────

export interface Harness {
  env: Env;
  kv: MemoryKV;
  jobs: MemoryJobs;
  ctx: Ctx;
  fake: FakePopNow;
  platform: ReturnType<typeof stubPlatforms>;
  discordKey: CryptoKeyPair;
  call: (request: Request) => Promise<Response>;
  close: () => void;
}

export async function harness(): Promise<Harness> {
  const fake = await startPopNow();
  const kv = new MemoryKV();
  const jobs = new MemoryJobs();
  const discordKey = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicHex = Buffer.from(await crypto.subtle.exportKey("raw", discordKey.publicKey)).toString("hex");
  const env: Env = {
    DATA: kv,
    JOBS: jobs,
    PUBLIC_URL: "https://bots.popnow.ai",
    POPNOW_MCP_URL: `${fake.origin}/mcp`,
    TOKEN_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    DISCORD_APPLICATION_ID: "app1",
    DISCORD_PUBLIC_KEY: publicHex,
    DISCORD_BOT_TOKEN: "bot-test",
    SLACK_SIGNING_SECRET: "slack-signing-secret",
    SLACK_CLIENT_ID: "123.456",
    SLACK_CLIENT_SECRET: "slack-client-secret",
    SLACK_BOT_TOKEN: "xoxb-env",
  };
  jobs.env = env;
  const ctx = new Ctx();
  const platform = stubPlatforms();
  return {
    env,
    kv,
    jobs,
    ctx,
    fake,
    platform,
    discordKey,
    call: async (request) => {
      const response = await handle(request, env, ctx);
      return response;
    },
    close: () => {
      platform.restore();
      fake.server.close();
    },
  };
}

export async function discordRequest(h: Harness, payload: unknown, options: { age?: number; tamper?: boolean } = {}): Promise<Request> {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(time.now / 1000) - (options.age ?? 0));
  const signature = Buffer.from(
    await crypto.subtle.sign("Ed25519", h.discordKey.privateKey, new TextEncoder().encode(timestamp + body)),
  ).toString("hex");
  return new Request("https://bots.popnow.ai/discord/interactions", {
    method: "POST",
    headers: { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp, "content-type": "application/json" },
    body: options.tamper ? body.replace("}", ',"x":1}') : body,
  });
}

export async function slackRequest(
  h: Harness,
  path: "/slack/events" | "/slack/commands" | "/slack/interactions",
  body: string,
  options: { age?: number; secret?: string; headers?: Record<string, string> } = {},
): Promise<Request> {
  const timestamp = String(Math.floor(time.now / 1000) - (options.age ?? 0));
  const signature = `v0=${await hmacSha256Hex(options.secret ?? (h.env.SLACK_SIGNING_SECRET as string), `v0:${timestamp}:${body}`)}`;
  return new Request(`https://bots.popnow.ai${path}`, {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
      "content-type": path === "/slack/events" ? "application/json" : "application/x-www-form-urlencoded",
      ...(options.headers ?? {}),
    },
    body,
  });
}

/** Follows a Connect link the way a person would: open, press Continue, sign in, come back. */
export async function completeConnect(h: Harness, connectUrl: string): Promise<Response> {
  const path = new URL(connectUrl).pathname;
  const page = await h.call(new Request(`https://bots.popnow.ai${path}`));
  if (page.status !== 200) throw new Error(`connect page ${page.status}`);
  const go = await h.call(new Request(`https://bots.popnow.ai${path}`, { method: "POST" }));
  const authorize = go.headers.get("location");
  if (go.status !== 302 || !authorize) throw new Error(`continue ${go.status}`);
  const consent = await fetch(authorize, { redirect: "manual" });
  const back = consent.headers.get("location");
  if (!back) throw new Error(`authorize ${consent.status}`);
  const callback = new URL(back);
  return h.call(new Request(`https://bots.popnow.ai${callback.pathname}${callback.search}`));
}
