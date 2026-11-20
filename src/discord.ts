import { clientFor, createBindLink, isLinked, refOf, unlink } from "./accounts.js";
import { buttonId, buttonsFor, parseButtonId, REPLIES, statusLine, type Card } from "./cards.js";
import { ACCENT_INT, PlanError, planFor, PRICING_URL, type Action, type CommandInput } from "./commands.js";
import { shortId, verifyEd25519 } from "./crypto.js";
import { clock, configured, type Env, type ExecutionContext, type UserRef } from "./env.js";
import type { ClickReply, OpenRequest } from "./job.js";
import { textOf, type JobFile } from "./mcp.js";
import { fileName, readCapped, type DiscordContext, type Surface, type SurfaceContext } from "./surfaces.js";
import { effectChoices, putQuote, readQuote } from "./store.js";
import type { ChatFile } from "./upload.js";

/**
 * Discord adapter: one slash command, /popnow, on the interactions endpoint (Ed25519-signed).
 * Paid commands answer with a deferred reply, then the job's Durable Object edits it into a quote
 * card with "Create · N credits" and "Cancel". Only the person who asked can press them.
 */

export const API = "https://discord.com/api/v10";
/** Discord accepts files up to this size from bots; bigger results are sent as links. */
export const DISCORD_UPLOAD_LIMIT = 25 * 1024 * 1024;
const TOKEN_FRESH_MS = 14 * 60_000;
const SIGNATURE_MAX_AGE_S = 5 * 60;
const EPHEMERAL = 64;

const enum Type {
  Ping = 1,
  Command = 2,
  Component = 3,
  Autocomplete = 4,
}

const enum Reply {
  Pong = 1,
  Message = 4,
  Deferred = 5,
  UpdateMessage = 7,
  Choices = 8,
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const NO_PINGS = { parse: [] as string[] };

/** Checks the Ed25519 signature over timestamp + body, and that the request is under 5 minutes old. */
export async function verifyDiscord(env: Env, request: Request, body: string): Promise<boolean> {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (!env.DISCORD_PUBLIC_KEY || !signature || !timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(clock.now() / 1000 - Number(timestamp)) > SIGNATURE_MAX_AGE_S) return false;
  return verifyEd25519(env.DISCORD_PUBLIC_KEY, signature, timestamp + body);
}

export function renderCard(card: Card): Record<string, unknown> {
  const status = statusLine(card);
  const description = [card.summary ? `> ${card.summary.replace(/\n/g, " ")}` : "", status].filter(Boolean).join("\n");
  const buttons = buttonsFor(card, PRICING_URL).map((button) =>
    button.url
      ? { type: 2, style: 5, label: button.label, url: button.url }
      : { type: 2, style: button.style === "primary" ? 1 : 2, label: button.label, custom_id: buttonId(button.kind!, card) },
  );
  return {
    content: "",
    embeds: [{ color: ACCENT_INT, title: card.title, description }],
    components: buttons.length ? [{ type: 1, components: buttons }] : [],
    allowed_mentions: NO_PINGS,
  };
}

function connectMessage(url: string, text = "Connect your PopNow account to create with your credits."): Record<string, unknown> {
  return {
    flags: EPHEMERAL,
    content: text,
    components: [{ type: 1, components: [{ type: 2, style: 5, label: "Connect PopNow", url }] }],
    allowed_mentions: NO_PINGS,
  };
}

const ephemeral = (content: string): Response =>
  json({ type: Reply.Message, data: { flags: EPHEMERAL, content, allowed_mentions: NO_PINGS } });

interface Option {
  name: string;
  type: number;
  value?: unknown;
  focused?: boolean;
  options?: Option[];
}

interface Attachment {
  id: string;
  url: string;
  filename: string;
  content_type?: string;
  size?: number;
}

interface Interaction {
  type: number;
  token: string;
  application_id: string;
  guild_id?: string;
  channel_id?: string;
  channel?: { id?: string };
  member?: { user?: { id: string } };
  user?: { id: string };
  data?: {
    name?: string;
    custom_id?: string;
    options?: Option[];
    resolved?: { attachments?: Record<string, Attachment> };
  };
}

function userOf(interaction: Interaction): UserRef | undefined {
  const id = interaction.member?.user?.id ?? interaction.user?.id;
  return id ? refOf("discord", interaction.guild_id, id) : undefined;
}

// ── REST, through the interaction token while it is fresh, else the bot token ─────────────────

async function discordFetch(env: Env, url: string, init: RequestInit, bot: boolean): Promise<Response> {
  const headers = new Headers(init.headers);
  if (bot && env.DISCORD_BOT_TOKEN) headers.set("authorization", `Bot ${env.DISCORD_BOT_TOKEN}`);
  headers.set("user-agent", "DiscordBot (https://popnow.ai, 0.1.0)");
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(60_000) });
    if (response.status !== 429 || attempt >= 2) return response;
    const wait = Number(response.headers.get("retry-after") ?? "1");
    await new Promise((resolve) => setTimeout(resolve, Math.min(5, Math.max(0.2, wait)) * 1000));
  }
}

function fresh(context: DiscordContext): boolean {
  return clock.now() - context.tokenAt < TOKEN_FRESH_MS;
}

async function editCard(env: Env, context: DiscordContext, body: Record<string, unknown>): Promise<void> {
  let response: Response | undefined;
  if (fresh(context)) {
    response = await discordFetch(
      env,
      `${API}/webhooks/${context.appId}/${context.token}/messages/@original`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      false,
    );
  } else if (context.channelId && context.messageId && env.DISCORD_BOT_TOKEN) {
    response = await discordFetch(
      env,
      `${API}/channels/${context.channelId}/messages/${context.messageId}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      true,
    );
  }
  if (response?.ok) {
    const message = (await response.json().catch(() => ({}))) as { id?: string; channel_id?: string };
    if (message.id) context.messageId = message.id;
    if (message.channel_id) context.channelId = message.channel_id;
  }
}

async function sendMessage(env: Env, context: DiscordContext, payload: Record<string, unknown>, files: { name: string; bytes: Uint8Array<ArrayBuffer>; type: string }[]): Promise<boolean> {
  const form = new FormData();
  form.set("payload_json", JSON.stringify({ ...payload, attachments: files.map((file, id) => ({ id, filename: file.name })) }));
  files.forEach((file, i) => form.set(`files[${i}]`, new Blob([file.bytes], { type: file.type || "application/octet-stream" }), file.name));
  if (fresh(context)) {
    const response = await discordFetch(env, `${API}/webhooks/${context.appId}/${context.token}?wait=true`, { method: "POST", body: form }, false);
    if (response.ok) return true;
  }
  if (context.channelId && env.DISCORD_BOT_TOKEN) {
    const response = await discordFetch(env, `${API}/channels/${context.channelId}/messages`, { method: "POST", body: form }, true);
    return response.ok;
  }
  return false;
}

export function discordSurface(env: Env): Surface {
  return {
    async showCard(card: Card, context: SurfaceContext): Promise<void> {
      if (context.platform !== "discord") return;
      await editCard(env, context, renderCard(card));
    },
    async deliver(card: Card, context: SurfaceContext, files: JobFile[]): Promise<void> {
      if (context.platform !== "discord") return;
      const attached: { name: string; bytes: Uint8Array<ArrayBuffer>; type: string }[] = [];
      const links: string[] = [];
      for (const [i, file] of files.slice(0, 4).entries()) {
        const got = await readCapped(file.url, DISCORD_UPLOAD_LIMIT).catch(() => undefined);
        if (got) attached.push({ name: fileName(file, i, got.type), bytes: got.bytes, type: file.type || got.type });
        else links.push(file.url);
      }
      const mention = `<@${card.owner.user}>`;
      const content = [links.length ? `${mention} Ready:` : `${mention} Ready.`, ...links].join("\n");
      await sendMessage(env, context, { content, allowed_mentions: { users: [card.owner.user] } }, attached);
    },
  };
}

// ── Interactions ──────────────────────────────────────────────────────────────────────────────

function optionsOf(interaction: Interaction): { sub: string; values: Map<string, Option> } {
  const top = interaction.data?.options?.[0];
  const values = new Map<string, Option>();
  for (const option of top?.options ?? []) values.set(option.name, option);
  return { sub: top?.name ?? "", values };
}

function chatFile(interaction: Interaction, option: Option | undefined): ChatFile | undefined {
  if (!option || typeof option.value !== "string") return undefined;
  const attachment = interaction.data?.resolved?.attachments?.[option.value];
  if (!attachment) return undefined;
  return {
    url: attachment.url,
    name: attachment.filename,
    contentType: attachment.content_type ?? "application/octet-stream",
    ...(attachment.size === undefined ? {} : { size: attachment.size }),
  };
}

const PAID: readonly string[] = ["image", "video", "edit", "animate", "effect", "remove-bg", "upscale"];

async function jobStub(env: Env, id: string) {
  return env.JOBS.get(env.JOBS.idFromName(id));
}

async function onCommand(env: Env, ctx: ExecutionContext, interaction: Interaction, ref: UserRef): Promise<Response> {
  const { sub, values } = optionsOf(interaction);
  const str = (name: string): string | undefined => {
    const value = values.get(name)?.value;
    return typeof value === "string" ? value : undefined;
  };

  if (sub === "login") {
    if (await isLinked(env, ref)) return ephemeral("You're connected. Use /popnow logout to disconnect.");
    return json({ type: Reply.Message, data: connectMessage(await createBindLink(env, ref)) });
  }
  if (sub === "logout") {
    if (!(await isLinked(env, ref))) return ephemeral("You weren't connected.");
    ctx.waitUntil(unlink(env, ref));
    return ephemeral("Disconnected from PopNow.");
  }
  if (!(await isLinked(env, ref))) {
    return json({ type: Reply.Message, data: connectMessage(await createBindLink(env, ref)) });
  }

  if (sub === "balance" || sub === "creations") {
    ctx.waitUntil(
      (async () => {
        const context: DiscordContext = { platform: "discord", appId: interaction.application_id, token: interaction.token, tokenAt: clock.now() };
        let content: string;
        try {
          const client = await clientFor(env, ref);
          const result = client
            ? await client.callTool(sub === "balance" ? "check_balance" : "list_my_creations", sub === "balance" ? {} : { limit: 5 }, 30_000)
            : undefined;
          content = result ? textOf(result).slice(0, 1900) || "Nothing yet." : "Connect PopNow first: /popnow login";
        } catch {
          content = "PopNow didn't answer. Try again in a minute.";
        }
        await editCard(env, context, { content, embeds: [], components: [], allowed_mentions: NO_PINGS });
      })(),
    );
    return json({ type: Reply.Deferred, data: { flags: EPHEMERAL } });
  }

  if (!PAID.includes(sub)) return ephemeral("Try /popnow image, video, edit, animate, effect, remove-bg or upscale.");
  const action = sub as Action;
  const file = chatFile(interaction, values.get("image") ?? values.get("file"));
  if (file) {
    const okType = action === "upscale" ? /^(image|video)\//.test(file.contentType) : file.contentType.startsWith("image/");
    if (!okType) return ephemeral(action === "upscale" ? "Attach a photo or a video." : "Attach a photo.");
  }
  const seconds = values.get("seconds")?.value;
  const input: CommandInput = {
    ...(str("prompt") ? { prompt: str("prompt") as string } : {}),
    ...(str("aspect") ? { aspect: str("aspect") as string } : {}),
    ...(typeof seconds === "number" ? { seconds } : {}),
    ...(str("effect") ? { effect: str("effect") as string } : {}),
    ...(str("size") ? { size: str("size") as string } : {}),
    ...(file ? { file } : {}),
  };
  let plan;
  try {
    plan = planFor(action, input);
  } catch (error) {
    if (error instanceof PlanError) return ephemeral(error.message);
    throw error;
  }
  const id = shortId();
  const surface: DiscordContext = {
    platform: "discord",
    appId: interaction.application_id,
    token: interaction.token,
    tokenAt: clock.now(),
    ...(interaction.channel_id ?? interaction.channel?.id ? { channelId: (interaction.channel_id ?? interaction.channel?.id) as string } : {}),
  };
  const open: OpenRequest = { id, owner: ref, plan, surface };
  await putQuote(env, id, ref);
  ctx.waitUntil(
    jobStub(env, id).then((stub) =>
      stub.fetch(new Request("https://job/open", { method: "POST", body: JSON.stringify(open), headers: { "content-type": "application/json" } })),
    ),
  );
  return json({ type: Reply.Deferred });
}

async function onComponent(env: Env, interaction: Interaction, ref: UserRef): Promise<Response> {
  const parsed = parseButtonId(interaction.data?.custom_id ?? "");
  if (!parsed) return ephemeral(REPLIES.gone);
  const quote = await readQuote(env, parsed.id);
  if (!quote) return ephemeral(REPLIES.gone);
  if (quote.platform !== ref.platform || quote.workspace !== ref.workspace || quote.user !== ref.user) return ephemeral(REPLIES.notOwner);
  const stub = await jobStub(env, parsed.id);
  const response = await stub.fetch(
    new Request("https://job/click", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: parsed.kind, rev: parsed.rev, user: ref, surface: { token: interaction.token, tokenAt: clock.now() } }),
    }),
  );
  const reply = (await response.json()) as ClickReply;
  if (reply.card) return json({ type: Reply.UpdateMessage, data: renderCard(reply.card) });
  return ephemeral(reply.reply ?? REPLIES.gone);
}

async function onAutocomplete(env: Env, interaction: Interaction, ref: UserRef): Promise<Response> {
  const { values } = optionsOf(interaction);
  const typed = String([...values.values()].find((option) => option.focused)?.value ?? "");
  const choices = await effectChoices(env, ref, typed);
  return json({ type: Reply.Choices, data: { choices: choices.slice(0, 25).map((c) => ({ name: c.name.slice(0, 100), value: c.slug.slice(0, 100) })) } });
}

export async function handleDiscord(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await request.text();
  if (!(await verifyDiscord(env, request, body))) return new Response("invalid request signature", { status: 401 });
  const interaction = JSON.parse(body) as Interaction;
  if (interaction.type === Type.Ping) return json({ type: Reply.Pong });
  const ref = userOf(interaction);
  if (!ref) return ephemeral("Run this from a server or a DM.");
  switch (interaction.type) {
    case Type.Command:
      return onCommand(env, ctx, interaction, ref);
    case Type.Component:
      return onComponent(env, interaction, ref);
    case Type.Autocomplete:
      return onAutocomplete(env, interaction, ref);
    default:
      return new Response("unsupported", { status: 400 });
  }
}

/** Install link: the bot (to post results when an interaction token has expired) plus the command. */
export function discordInstallUrl(env: Env): string | undefined {
  if (!configured(env.DISCORD_APPLICATION_ID)) return undefined;
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", env.DISCORD_APPLICATION_ID);
  url.searchParams.set("scope", "bot applications.commands");
  // View Channel, Send Messages, Embed Links, Attach Files.
  url.searchParams.set("permissions", String(1024 + 2048 + 16384 + 32768));
  return url.toString();
}
