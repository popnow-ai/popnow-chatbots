import type { UserRef } from "./env.js";

/**
 * A quote card as both platforms show it. The button price is the cap: the job is started with
 * max_credits set to exactly that number, and nothing is charged until the owner presses it.
 */

export type Stage =
  | "quoting"
  | "quoted"
  | "short"
  | "consent"
  | "starting"
  | "running"
  | "done"
  | "failed"
  | "canceled"
  | "expired"
  | "signin";

export interface Card {
  id: string;
  /** Bumped whenever the price changes, so buttons on an older price stop working. */
  rev: number;
  stage: Stage;
  title: string;
  summary: string;
  owner: UserRef;
  credits?: number;
  balance?: number;
  note?: string;
  /** For stage "signin". */
  connectUrl?: string;
}

export type ButtonKind = "create" | "cancel" | "consent";

export interface Button {
  label: string;
  style: "primary" | "secondary";
  /** Either a click we handle, or a link. */
  kind?: ButtonKind;
  url?: string;
}

export const credits = (n: number): string => `${n.toLocaleString("en-US")} credit${n === 1 ? "" : "s"}`;

export const CONSENT_LINE = "Confirm the people in your photo are you or agreed to this, and nobody is under 18.";

/** The status line under the summary; empty when the buttons say it all. */
export function statusLine(card: Card): string {
  switch (card.stage) {
    case "quoting":
      return "Getting the price…";
    case "quoted":
      return card.note ?? "";
    case "short":
      return `This needs ${credits(card.credits ?? 0)}. You have ${credits(card.balance ?? 0)}.`;
    case "consent":
      return CONSENT_LINE;
    case "starting":
      return `Starting · up to ${credits(card.credits ?? 0)}`;
    case "running":
      return card.note ?? `Making it · up to ${credits(card.credits ?? 0)}`;
    case "done":
      return `Done · ${credits(card.credits ?? 0)}`;
    case "failed":
      return card.note ?? "It didn't work.";
    case "canceled":
      return "Canceled. Nothing was charged.";
    case "expired":
      return "This price expired. Run the command again.";
    case "signin":
      return "Connect PopNow to continue. Nothing was charged.";
  }
}

export function buttonsFor(card: Card, pricingUrl: string): Button[] {
  switch (card.stage) {
    case "quoted":
      return [
        { label: `Create · ${credits(card.credits ?? 0)}`, style: "primary", kind: "create" },
        { label: "Cancel", style: "secondary", kind: "cancel" },
      ];
    case "short":
      return [
        { label: "Get credits", style: "primary", url: pricingUrl },
        { label: "Cancel", style: "secondary", kind: "cancel" },
      ];
    case "consent":
      return [
        { label: "I confirm", style: "primary", kind: "consent" },
        { label: "Cancel", style: "secondary", kind: "cancel" },
      ];
    case "signin":
      return card.connectUrl ? [{ label: "Connect PopNow", style: "primary", url: card.connectUrl }] : [];
    default:
      return [];
  }
}

/** Short ids in buttons: `pn:<kind>:<quote>:<rev>`. Nothing else goes in them. */
export function buttonId(kind: ButtonKind, card: Pick<Card, "id" | "rev">): string {
  return `pn:${kind}:${card.id}:${card.rev}`;
}

export function parseButtonId(value: string): { kind: ButtonKind; id: string; rev: number } | undefined {
  const match = /^pn:(create|cancel|consent):([a-z0-9]{6,16}):(\d{1,4})$/.exec(value);
  if (!match) return undefined;
  return { kind: match[1] as ButtonKind, id: match[2] as string, rev: Number(match[3]) };
}

/** Messages shown only to the person who pressed. */
export const REPLIES = {
  notOwner: "Only the person who asked can use these buttons.",
  gone: "This price expired. Run the command again.",
  stale: "The price changed. Use the newest buttons.",
  started: "Already started.",
  finished: "This one is finished.",
};
