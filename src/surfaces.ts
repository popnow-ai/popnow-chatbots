import type { Card } from "./cards.js";
import { discordSurface } from "./discord.js";
import type { Env } from "./env.js";
import type { JobFile } from "./mcp.js";
import { slackSurface } from "./slack.js";

/** Where a quote card lives and how to reach it again. Saved with the job. */
export interface DiscordContext {
  platform: "discord";
  appId: string;
  /** The newest interaction token (valid 15 minutes): the command's, then each button press's. */
  token: string;
  tokenAt: number;
  channelId?: string;
  messageId?: string;
}

export interface SlackContext {
  platform: "slack";
  team: string;
  channel: string;
  /** The thread the request came from (a mention), if any. */
  threadTs?: string;
  /** The card message, once posted. */
  ts?: string;
  /** A slash command's reply address, for channels the bot is not in. */
  responseUrl?: string;
  viaResponseUrl?: boolean;
}

export type SurfaceContext = DiscordContext | SlackContext;

export interface Surface {
  /** Posts the card the first time, edits it afterwards. May record message ids on the context. */
  showCard(card: Card, context: SurfaceContext): Promise<void>;
  /** Posts the finished files next to the card (images attached; big videos as links). */
  deliver(card: Card, context: SurfaceContext, files: JobFile[]): Promise<void>;
}

export function surfaceFor(env: Env, context: SurfaceContext): Surface {
  return context.platform === "discord" ? discordSurface(env) : slackSurface(env);
}

/** Reads a download up to `limit` bytes; undefined when it is bigger (then we send a link). */
export async function readCapped(url: string, limit: number): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string } | undefined> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) return undefined;
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) {
    await response.body.cancel().catch(() => undefined);
    return undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { bytes, type: response.headers.get("content-type") ?? "" };
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

export function fileName(file: JobFile, index: number, sniffed = ""): string {
  const type = (file.type || sniffed).split(";")[0]?.trim() ?? "";
  const fromUrl = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(new URL(file.url).pathname)?.[1];
  const ext = EXT[type] ?? fromUrl ?? "bin";
  return `popnow-${index + 1}.${ext}`;
}
