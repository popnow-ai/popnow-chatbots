import type { ChatFile } from "./upload.js";

/**
 * What a chat command asks PopNow to make, independent of Discord or Slack.
 * Feature names follow popnow.ai. No face swap: it is paused on the website.
 */

export type Action = "image" | "video" | "edit" | "animate" | "effect" | "remove-bg" | "upscale";

export const ACTIONS: readonly Action[] = ["image", "video", "edit", "animate", "effect", "remove-bg", "upscale"];

export const ACCENT = "#E65A2F";
export const ACCENT_INT = 0xe65a2f;
export const SITE = "https://popnow.ai";
export const PRICING_URL = `${SITE}/pricing`;
export const CREATIONS_URL = `${SITE}/assets`;

/** Card titles, named like the website. */
export const TITLES: Record<Action, string> = {
  image: "Image",
  video: "Video",
  edit: "Edit photo",
  animate: "Image to video",
  effect: "Effect",
  "remove-bg": "Remove background",
  upscale: "Upscale",
};

export interface CommandInput {
  prompt?: string;
  aspect?: string;
  seconds?: number;
  effect?: string;
  size?: string;
  /** A file from the chat, uploaded before pricing. */
  file?: ChatFile;
  /** Or a link the user pasted (https:// or popnow://), passed through as is. */
  link?: string;
}

export interface Plan {
  action: Action;
  tool: string;
  args: Record<string, unknown>;
  /** The argument that takes the photo or video, filled after upload. */
  mediaKey?: "image_url" | "video_url";
  file?: ChatFile;
  /** Short line for the card, the user's own words. */
  summary: string;
}

export class PlanError extends Error {}

const ASPECTS = new Set(["1:1", "16:9", "9:16", "4:5", "3:4", "4:3", "3:2", "2:3", "21:9"]);

function clip(text: string, max = 300): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export function planFor(action: Action, input: CommandInput): Plan {
  const prompt = input.prompt?.trim() ?? "";
  const aspect = input.aspect && ASPECTS.has(input.aspect) ? input.aspect : undefined;
  const seconds = input.seconds && Number.isInteger(input.seconds) && input.seconds > 0 && input.seconds <= 20 ? input.seconds : undefined;
  const media = input.file ?? input.link;
  const needMedia = (what: string): void => {
    if (!media) throw new PlanError(`Add ${what}.`);
  };
  const needPrompt = (): void => {
    if (!prompt) throw new PlanError("Say what you want to see.");
  };
  const withMedia = (plan: Omit<Plan, "file">, key: "image_url" | "video_url"): Plan => {
    const args = { ...plan.args };
    if (input.link) args[key] = input.link;
    return { ...plan, args, mediaKey: key, ...(input.file ? { file: input.file } : {}) };
  };

  switch (action) {
    case "image":
      needPrompt();
      return { action, tool: "create_image", args: { prompt, ...(aspect ? { aspect_ratio: aspect } : {}) }, summary: clip(prompt) };
    case "video": {
      needPrompt();
      const args = { prompt, ...(seconds ? { duration_seconds: seconds } : {}), ...(aspect && !media ? { aspect_ratio: aspect } : {}) };
      const plan: Plan = { action, tool: "create_video", args, summary: clip(prompt) };
      return media ? withMedia(plan, "image_url") : plan;
    }
    case "edit":
      needMedia("a photo");
      needPrompt();
      return withMedia({ action, tool: "edit_image", args: { prompt, ...(aspect ? { aspect_ratio: aspect } : {}) }, summary: clip(prompt) }, "image_url");
    case "animate": {
      needMedia("a photo");
      const text = prompt || "Bring this photo to life.";
      return withMedia(
        { action, tool: "create_video", args: { prompt: text, ...(seconds ? { duration_seconds: seconds } : {}) }, summary: clip(prompt || "Your photo, moving") },
        "image_url",
      );
    }
    case "effect": {
      const effect = input.effect?.trim();
      if (!effect) throw new PlanError("Pick an effect.");
      needMedia("a photo");
      return withMedia({ action, tool: "apply_effect", args: { effect }, summary: clip(effect, 80) }, "image_url");
    }
    case "remove-bg":
      needMedia("a photo");
      return withMedia({ action, tool: "remove_background", args: {}, summary: "Your photo" }, "image_url");
    case "upscale": {
      needMedia("a photo or a video");
      const isVideo = input.file ? input.file.contentType.startsWith("video/") : /\.(mp4|mov|webm)(\?|$)/i.test(input.link ?? "");
      return withMedia(
        { action, tool: "upscale", args: { ...(input.size ? { size: input.size } : {}) }, summary: isVideo ? "Your video" : "Your photo" },
        isVideo ? "video_url" : "image_url",
      );
    }
  }
}

/** Slack text commands: "video a dog surfing", "edit <link> make it night", or just a prompt (an image). */
export function parseText(text: string): { action: Action | "balance" | "creations" | "login" | "logout" | "help"; input: CommandInput } {
  let rest = text.replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, " ").trim();
  const word = rest.split(/\s+/)[0]?.toLowerCase() ?? "";
  const aliases: Record<string, Action | "balance" | "creations" | "login" | "logout" | "help"> = {
    image: "image", picture: "image", video: "video", edit: "edit", animate: "animate", effect: "effect",
    "remove-bg": "remove-bg", removebg: "remove-bg", "remove-background": "remove-bg", upscale: "upscale",
    balance: "balance", credits: "balance", creations: "creations", login: "login", connect: "login",
    logout: "logout", disconnect: "logout", help: "help",
  };
  const action = aliases[word];
  if (action) rest = rest.slice(word.length).trim();
  const input: CommandInput = {};
  // Slack writes links as <https://…|label> or <https://…>.
  const linkMatch = rest.match(/<((?:https:\/\/|popnow:\/\/)[^>|]+)(?:\|[^>]*)?>/) ?? rest.match(/((?:https:\/\/|popnow:\/\/)\S+)/);
  if (linkMatch?.[1]) {
    input.link = linkMatch[1];
    rest = rest.replace(linkMatch[0], " ").trim();
  }
  const aspect = rest.match(/(?:^|\s)--?(?:ar|aspect)\s+(\d+:\d+)\b/i);
  if (aspect?.[1]) {
    input.aspect = aspect[1];
    rest = rest.replace(aspect[0], " ").trim();
  }
  if (action === "effect") {
    // "effect Tiny Planet <link>": everything left is the effect name.
    input.effect = rest.replace(/\s+/g, " ").trim();
  } else if (rest) {
    input.prompt = rest.replace(/\s+/g, " ");
  }
  return { action: action ?? (input.link ? "edit" : rest ? "image" : "help"), input };
}

export const HELP_TEXT =
  "Make images and videos with your PopNow credits.\n" +
  "image <prompt> · video <prompt> · edit <photo link> <prompt> · animate <photo link> · effect <name> <photo link> · remove-bg <photo link> · upscale <link> · balance · creations · logout";
