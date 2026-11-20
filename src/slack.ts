import { clientFor, createBindLink, isLinked, refOf, unlink } from "./accounts.js";
import { buttonId, buttonsFor, parseButtonId, REPLIES, statusLine, type Card } from "./cards.js";
import { ACCENT, HELP_TEXT, parseText, PlanError, planFor, PRICING_URL, type Action } from "./commands.js";
import { hmacSha256Hex, randomToken, shortId, timingSafeEqual } from "./crypto.js";
import { clock, configured, type Env, type ExecutionContext, type UserRef } from "./env.js";
import type { ClickReply, OpenRequest } from "./job.js";
import { textOf, type JobFile } from "./mcp.js";
import { fileName, readCapped, type SlackContext, type Surface, type SurfaceContext } from "./surfaces.js";
import { firstTime, putQuote, readQuote, saveTeamToken, teamToken } from "./store.js";
import { isSlackFileUrl, type ChatFile } from "./upload.js";

/**
 * Slack adapter: it only acts when mentioned (or on /popnow),
 * asks first-time users to Authorize, and answers in the thread. Requests are checked with the v0
 * HMAC signature; anything older than 5 minutes is refused. Slack wants an answer within 3 seconds,
 * so work goes to ctx.waitUntil and the job's Durable Object.
 */

export const SLACK_API = "https://slack.com/api";
export const SLACK_SCOPES = "app_mentions:read,chat:write,commands,files:read,files:write,im:write";
/** Bigger results are posted as links (the Worker holds a file in memory to upload it). */
export const SLACK_UPLOAD_LIMIT = 50 * 1024 * 1024;
const SIGNATURE_MAX_AGE_S = 5 * 60;

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const ok = (): Response => new Response("", { status: 200 });

export async function verifySlack(env: Env, request: Request, body: string): Promise<boolean> {
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");
  if (!env.SLACK_SIGNING_SECRET || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(clock.now() / 1000 - Number(timestamp)) > SIGNATURE_MAX_AGE_S) return false;
  const expected = `v0=${await hmacSha256Hex(env.SLACK_SIGNING_SECRET, `v0:${timestamp}:${body}`)}`;
  return timingSafeEqual(expected, signature);
}

const escape = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderSlackCard(card: Card): { text: string; attachments: unknown[] } {
  const status = statusLine(card);
  const lines = [`*${card.title}*`];
  if (card.summary) lines.push(`>${escape(card.summary)}`);
  if (status) lines.push(escape(status));
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }];
  const buttons = buttonsFor(card, PRICING_URL).map((button) => ({
    type: "button",
    text: { type: "plain_text", text: button.label },
    ...(button.style === "primary" ? { style: "primary" } : {}),
    ...(button.url ? { url: button.url, action_id: "pn_link" } : { action_id: `pn_${button.kind}`, value: buttonId(button.kind!, card) }),
  }));
  if (buttons.length) blocks.push({ type: "actions", elements: buttons });
  const fallback = [card.title, card.summary, status].filter(Boolean).join(" · ");
  return { text: fallback, attachments: [{ color: ACCENT, fallback, blocks }] };
}

function authorizeBlocks(url: string): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: "Connect your PopNow account to create with your credits." } },
    {
      type: "actions",
      elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: "Authorize" }, url, action_id: "pn_link" }],
    },
  ];
}

interface SlackReply {
  ok?: boolean;
  error?: string;
  ts?: string;
  channel?: string | { id?: string };
  upload_url?: string;
  file_id?: string;
  access_token?: string;
  team?: { id?: string };
}

async function slackCall(token: string, method: string, body: Record<string, unknown>, form = false): Promise<SlackReply> {
  const init: RequestInit = form
    ? {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(Object.entries(body).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])).toString(),
      }
    : {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      };
  const response = await fetch(`${SLACK_API}/${method}`, { ...init, signal: AbortSignal.timeout(30_000) });
  return ((await response.json().catch(() => ({ ok: false, error: `http_${response.status}` }))) as SlackReply) ?? {};
}

async function respond(url: string, body: Record<string, unknown>): Promise<void> {
  // Slack hands these out per command or click; only post to Slack's own hooks.
  if (!/^https:\/\/hooks\.slack\.com\//.test(url)) return;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
}

async function ephemeralTo(env: Env, team: string, channel: string, user: string, threadTs: string | undefined, text: string, blocks?: unknown[]): Promise<void> {
  const token = await teamToken(env, team);
  if (!token) return;
  await slackCall(token, "chat.postEphemeral", { channel, user, text, ...(threadTs ? { thread_ts: threadTs } : {}), ...(blocks ? { blocks } : {}) });
}

export function slackSurface(env: Env): Surface {
  return {
    async showCard(card: Card, context: SurfaceContext): Promise<void> {
      if (context.platform !== "slack") return;
      const token = await teamToken(env, context.team);
      const message = renderSlackCard(card);
      if (token && context.ts) {
        const reply = await slackCall(token, "chat.update", { channel: context.channel, ts: context.ts, ...message });
        if (reply.ok) return;
      }
      if (token && !context.ts && !context.viaResponseUrl) {
        const reply = await slackCall(token, "chat.postMessage", {
          channel: context.channel,
          ...(context.threadTs ? { thread_ts: context.threadTs } : {}),
          unfurl_links: false,
          ...message,
        });
        if (reply.ok && reply.ts) {
          context.ts = reply.ts;
          return;
        }
      }
      if (context.responseUrl) {
        await respond(context.responseUrl, { response_type: "in_channel", replace_original: Boolean(context.viaResponseUrl), ...message });
        context.viaResponseUrl = true;
      }
    },
    async deliver(card: Card, context: SurfaceContext, files: JobFile[]): Promise<void> {
      if (context.platform !== "slack") return;
      const token = await teamToken(env, context.team);
      const thread = context.threadTs ?? context.ts;
      const mention = `<@${card.owner.user}>`;
      const links: string[] = [];
      const uploaded: { id: string; title: string }[] = [];
      if (token && !context.viaResponseUrl) {
        for (const [i, file] of files.slice(0, 4).entries()) {
          const got = await readCapped(file.url, SLACK_UPLOAD_LIMIT).catch(() => undefined);
          if (!got) {
            links.push(file.url);
            continue;
          }
          const name = fileName(file, i, got.type);
          const ticket = await slackCall(token, "files.getUploadURLExternal", { filename: name, length: String(got.bytes.length) }, true);
          if (!ticket.ok || !ticket.upload_url || !ticket.file_id) {
            links.push(file.url);
            continue;
          }
          const put = await fetch(ticket.upload_url, { method: "POST", body: got.bytes, signal: AbortSignal.timeout(120_000) });
          if (put.ok) uploaded.push({ id: ticket.file_id, title: name });
          else links.push(file.url);
        }
      } else {
        links.push(...files.slice(0, 4).map((file) => file.url));
      }
      if (token && uploaded.length) {
        const done = await slackCall(
          token,
          "files.completeUploadExternal",
          { files: uploaded, channel_id: context.channel, ...(thread ? { thread_ts: thread } : {}), initial_comment: `${mention} Ready.` },
          true,
        );
        if (!done.ok) links.push(...files.slice(0, 4).map((file) => file.url));
      }
      if (links.length) {
        const text = [`${mention} Ready:`, ...links].join("\n");
        const posted = token && !context.viaResponseUrl
          ? await slackCall(token, "chat.postMessage", { channel: context.channel, ...(thread ? { thread_ts: thread } : {}), text })
          : { ok: false };
        if (!posted.ok && context.responseUrl) await respond(context.responseUrl, { response_type: "in_channel", replace_original: false, text });
      }
    },
  };
}

// ── Shared request handling ───────────────────────────────────────────────────────────────────

interface Asked {
  ref: UserRef;
  team: string;
  channel: string;
  threadTs?: string;
  responseUrl?: string;
  /** The first file the person sent with this mention, if any. */
  file?: ChatFile;
}

interface SlackFile {
  url_private_download?: string;
  url_private?: string;
  name?: string;
  mimetype?: string;
  size?: number;
}

/** Only the files on the message that mentioned the bot; nothing else in the channel is read. */
export function fileFromEvent(team: string, files: SlackFile[] | undefined): ChatFile | undefined {
  const file = files?.[0];
  const url = file?.url_private_download ?? file?.url_private;
  if (!file || !url || !isSlackFileUrl(url)) return undefined;
  return {
    url,
    name: file.name ?? "file",
    contentType: file.mimetype ?? "application/octet-stream",
    ...(file.size === undefined ? {} : { size: file.size }),
    slackTeam: team,
  };
}

const MEDIA_ACTIONS = ["edit", "animate", "effect", "remove-bg", "upscale"];

/** Answers a command or mention. `say` replies only to the asker. */
async function run(env: Env, text: string, asked: Asked, say: (text: string, blocks?: unknown[]) => Promise<void>): Promise<void> {
  const { action, input } = parseText(text, Boolean(asked.file));
  if (asked.file && !input.link) {
    const okType = action === "upscale" ? /^(image|video)\//.test(asked.file.contentType) : asked.file.contentType.startsWith("image/");
    if ((MEDIA_ACTIONS.includes(action) || action === "video") && !okType) {
      return say(action === "upscale" ? "Attach a photo or a video." : "Attach a photo.");
    }
    if (MEDIA_ACTIONS.includes(action) || action === "video") input.file = asked.file;
  }
  if (action === "help") return say(HELP_TEXT);
  if (action === "logout") {
    return say((await unlink(env, asked.ref)) ? "Disconnected from PopNow." : "You weren't connected.");
  }
  if (!(await isLinked(env, asked.ref))) {
    const url = await createBindLink(env, asked.ref);
    return say("Connect your PopNow account to create with your credits.", authorizeBlocks(url));
  }
  if (action === "login") return say("You're connected. Say logout to disconnect.");
  if (action === "balance" || action === "creations") {
    try {
      const client = await clientFor(env, asked.ref);
      const result = await client?.callTool(action === "balance" ? "check_balance" : "list_my_creations", action === "balance" ? {} : { limit: 5 }, 30_000);
      return say(result ? textOf(result).slice(0, 2900) || "Nothing yet." : "Connect PopNow first.");
    } catch {
      return say("PopNow didn't answer. Try again in a minute.");
    }
  }
  let plan;
  try {
    plan = planFor(action as Action, input);
  } catch (error) {
    if (error instanceof PlanError) {
      const hint = MEDIA_ACTIONS.includes(action) && !input.link && !input.file ? " Attach a photo, or paste an image link." : "";
      return say(`${error.message}${hint}`);
    }
    throw error;
  }
  const id = shortId();
  const surface: SlackContext = {
    platform: "slack",
    team: asked.team,
    channel: asked.channel,
    ...(asked.threadTs ? { threadTs: asked.threadTs } : {}),
    ...(asked.responseUrl ? { responseUrl: asked.responseUrl } : {}),
  };
  const open: OpenRequest = { id, owner: asked.ref, plan, surface };
  await putQuote(env, id, asked.ref);
  const stub = env.JOBS.get(env.JOBS.idFromName(id));
  await stub.fetch(new Request("https://job/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(open) }));
}

interface MentionEvent {
  type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  files?: SlackFile[];
}

export async function handleSlackEvents(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await request.text();
  if (!(await verifySlack(env, request, body))) return new Response("invalid signature", { status: 401 });
  // Slack retries when we were slow; the first delivery is already being handled.
  if (request.headers.get("x-slack-retry-num")) return ok();
  const payload = JSON.parse(body) as { type?: string; challenge?: string; event_id?: string; team_id?: string; event?: MentionEvent };
  if (payload.type === "url_verification") return json({ challenge: payload.challenge ?? "" });
  if (payload.type !== "event_callback" || !payload.event_id || !payload.team_id) return ok();
  const event = payload.event ?? {};
  if (event.type !== "app_mention" || event.bot_id || !event.user || !event.channel) return ok();
  if (!(await firstTime(env, "slack", payload.event_id))) return ok();
  const team = payload.team_id;
  const thread = event.thread_ts ?? event.ts;
  const file = fileFromEvent(team, event.files);
  const asked: Asked = {
    ref: refOf("slack", team, event.user),
    team,
    channel: event.channel,
    ...(thread ? { threadTs: thread } : {}),
    ...(file ? { file } : {}),
  };
  ctx.waitUntil(
    run(env, event.text ?? "", asked, (text, blocks) => ephemeralTo(env, team, event.channel as string, event.user as string, thread, text, blocks)).catch((error) =>
      console.error(`slack mention: ${error instanceof Error ? error.name : "error"}`),
    ),
  );
  return ok();
}

export async function handleSlackCommand(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await request.text();
  if (!(await verifySlack(env, request, body))) return new Response("invalid signature", { status: 401 });
  const form = new URLSearchParams(body);
  const team = form.get("team_id") ?? "";
  const user = form.get("user_id") ?? "";
  const channel = form.get("channel_id") ?? "";
  const responseUrl = form.get("response_url") ?? "";
  if (!team || !user || !channel) return json({ response_type: "ephemeral", text: HELP_TEXT });
  const text = form.get("text") ?? "";
  const asked: Asked = { ref: refOf("slack", team, user), team, channel, ...(responseUrl ? { responseUrl } : {}) };
  ctx.waitUntil(
    run(env, text, asked, (reply, blocks) =>
      respond(responseUrl, { response_type: "ephemeral", replace_original: false, text: reply, ...(blocks ? { blocks } : {}) }),
    ).catch((error) => console.error(`slack command: ${error instanceof Error ? error.name : "error"}`)),
  );
  return ok();
}

interface BlockActions {
  type?: string;
  user?: { id?: string; team_id?: string };
  team?: { id?: string };
  channel?: { id?: string };
  response_url?: string;
  actions?: { action_id?: string; value?: string }[];
}

export async function handleSlackInteraction(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await request.text();
  if (!(await verifySlack(env, request, body))) return new Response("invalid signature", { status: 401 });
  const payload = JSON.parse(new URLSearchParams(body).get("payload") ?? "{}") as BlockActions;
  if (payload.type !== "block_actions") return ok();
  const action = payload.actions?.[0];
  const parsed = parseButtonId(action?.value ?? "");
  if (!parsed) return ok(); // link buttons (Authorize, Get credits) need only the acknowledgement
  const team = payload.team?.id ?? payload.user?.team_id ?? "";
  const ref = refOf("slack", team, payload.user?.id ?? "");
  const responseUrl = payload.response_url ?? "";
  const tell = (text: string): void => ctx.waitUntil(respond(responseUrl, { response_type: "ephemeral", replace_original: false, text }));
  const owner = await readQuote(env, parsed.id);
  if (!owner) {
    tell(REPLIES.gone);
    return ok();
  }
  if (owner.platform !== ref.platform || owner.workspace !== ref.workspace || owner.user !== ref.user) {
    tell(REPLIES.notOwner);
    return ok();
  }
  const stub = env.JOBS.get(env.JOBS.idFromName(parsed.id));
  const response = await stub.fetch(
    new Request("https://job/click", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: parsed.kind, rev: parsed.rev, user: ref }),
    }),
  );
  const reply = (await response.json()) as ClickReply;
  if (reply.card && reply.surface) {
    const surface = reply.surface;
    const card = reply.card;
    ctx.waitUntil(slackSurface(env).showCard(card, surface));
  } else {
    tell(reply.reply ?? REPLIES.gone);
  }
  return ok();
}

/** After a Slack user connects: a direct message, so they know it worked (uses im:write). */
export async function slackConnected(env: Env, ref: UserRef): Promise<void> {
  const token = await teamToken(env, ref.workspace);
  if (!token) return;
  const dm = await slackCall(token, "conversations.open", { users: ref.user });
  const channel = typeof dm.channel === "object" ? dm.channel?.id : dm.channel;
  if (!dm.ok || !channel) return;
  await slackCall(token, "chat.postMessage", { channel, text: "You're connected to PopNow. Mention @PopNow in a channel to create." });
}

// ── Installing into a workspace (OAuth v2) ────────────────────────────────────────────────────

export async function slackInstallRedirect(env: Env): Promise<Response> {
  if (!configured(env.SLACK_CLIENT_ID)) return new Response("Slack is not set up", { status: 404 });
  const state = randomToken(24);
  await env.DATA.put(`slack:install:${state}`, "1", { expirationTtl: 600 });
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", env.SLACK_CLIENT_ID);
  url.searchParams.set("scope", SLACK_SCOPES);
  url.searchParams.set("redirect_uri", `${env.PUBLIC_URL.replace(/\/$/, "")}/slack/oauth`);
  url.searchParams.set("state", state);
  return Response.redirect(url.toString(), 302);
}

/** Returns the team id once the bot token is stored, or undefined. */
export async function slackInstallFinish(env: Env, params: URLSearchParams): Promise<string | undefined> {
  const state = params.get("state") ?? "";
  const code = params.get("code");
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(state) || !code || !env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) return undefined;
  if (!(await env.DATA.get(`slack:install:${state}`))) return undefined;
  await env.DATA.delete(`slack:install:${state}`);
  const response = await fetch(`${SLACK_API}/oauth.v2.access`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: `${env.PUBLIC_URL.replace(/\/$/, "")}/slack/oauth`,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const reply = (await response.json().catch(() => ({}))) as SlackReply;
  if (!reply.ok || !reply.access_token || !reply.team?.id) return undefined;
  await saveTeamToken(env, reply.team.id, reply.access_token);
  return reply.team.id;
}
