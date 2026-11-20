import { clientFor } from "./accounts.js";
import { open, seal } from "./crypto.js";
import type { Env, UserRef } from "./env.js";
import { textOf } from "./mcp.js";

/**
 * Small KV records besides the bindings (see accounts.ts):
 * - `quote:<id>`         who asked for a quote, so other people's presses are turned away fast (1 day)
 * - `dedupe:<scope>:<id>` an event already handled (1 day)
 * - `presets:effects`    the effect list for Discord autocomplete (1 day)
 * - `slack:team:<team>`  a workspace's bot token, sealed
 * - `slack:install:<s>`  a Slack install in progress (10 minutes)
 * The job itself (price, state, the one start) lives in its Durable Object.
 */

export const QUOTE_KV_TTL_SECONDS = 24 * 60 * 60;
export const DEDUPE_TTL_SECONDS = 24 * 60 * 60;

export async function putQuote(env: Env, id: string, owner: UserRef): Promise<void> {
  await env.DATA.put(`quote:${id}`, JSON.stringify(owner), { expirationTtl: QUOTE_KV_TTL_SECONDS });
}

export async function readQuote(env: Env, id: string): Promise<UserRef | undefined> {
  const saved = await env.DATA.get(`quote:${id}`);
  return saved ? (JSON.parse(saved) as UserRef) : undefined;
}

/** True the first time an id is seen. */
export async function firstTime(env: Env, scope: string, id: string): Promise<boolean> {
  const key = `dedupe:${scope}:${id}`;
  if (await env.DATA.get(key)) return false;
  await env.DATA.put(key, "1", { expirationTtl: DEDUPE_TTL_SECONDS });
  return true;
}

export interface EffectChoice {
  name: string;
  slug: string;
}

/** Parses list_presets text lines such as "- Tiny Planet (tiny-planet): …". */
export function parseEffects(text: string, slugs: unknown): EffectChoice[] {
  const out: EffectChoice[] = [];
  for (const line of text.split("\n")) {
    const match = /^-\s+(.+?)\s+\(([a-z0-9][a-z0-9-]*)\):/.exec(line.trim());
    if (match?.[1] && match[2]) out.push({ name: match[1], slug: match[2] });
  }
  if (out.length === 0 && Array.isArray(slugs)) {
    for (const slug of slugs) if (typeof slug === "string") out.push({ name: slug.replace(/-/g, " "), slug });
  }
  return out;
}

/** Effects matching what was typed; the list is cached for a day, fetched with the asker's account. */
export async function effectChoices(env: Env, ref: UserRef, typed: string): Promise<EffectChoice[]> {
  let list: EffectChoice[] | undefined;
  const cached = await env.DATA.get("presets:effects");
  if (cached) list = JSON.parse(cached) as EffectChoice[];
  if (!list) {
    const client = await clientFor(env, ref);
    if (client) {
      // Autocomplete must answer within 3 seconds.
      const result = await Promise.race([
        client.callTool("list_presets", { kind: "effects" }, 2_500).catch(() => undefined),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2_500)),
      ]);
      if (result && !result.isError) {
        list = parseEffects(textOf(result), result.structuredContent?.effects);
        if (list.length) await env.DATA.put("presets:effects", JSON.stringify(list), { expirationTtl: 24 * 60 * 60 });
      }
    }
  }
  const needle = typed.trim().toLowerCase();
  return (list ?? []).filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.slug.includes(needle));
}

export async function saveTeamToken(env: Env, team: string, token: string): Promise<void> {
  const key = `slack:team:${team}`;
  await env.DATA.put(key, await seal(env.TOKEN_KEY, token, key));
}

export async function teamToken(env: Env, team: string): Promise<string | undefined> {
  const key = `slack:team:${team}`;
  const sealed = await env.DATA.get(key);
  if (sealed) {
    const token = await open(env.TOKEN_KEY, sealed, key);
    if (token) return token;
  }
  return env.SLACK_BOT_TOKEN || undefined;
}
