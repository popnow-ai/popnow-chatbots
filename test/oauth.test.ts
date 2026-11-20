import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBindLink } from "../src/accounts.js";
import { parseText, planFor } from "../src/commands.js";
import { discover, requireSecure } from "../src/oauth.js";
import { harness, time, type Harness } from "./helpers.js";

describe("binding", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  const ref = { platform: "discord" as const, workspace: "g1", user: "u1" };

  async function authorizeFor(): Promise<URL> {
    const link = await createBindLink(h.env, ref);
    const path = new URL(link).pathname;
    // A link preview (GET) does not use the link up.
    expect((await h.call(new Request(`https://bots.popnow.ai${path}`))).status).toBe(200);
    expect((await h.call(new Request(`https://bots.popnow.ai${path}`))).status).toBe(200);
    const go = await h.call(new Request(`https://bots.popnow.ai${path}`, { method: "POST" }));
    expect(go.status).toBe(302);
    const second = await h.call(new Request(`https://bots.popnow.ai${path}`, { method: "POST" }));
    expect(second.status).toBe(410);
    return new URL(go.headers.get("location") as string);
  }

  it("sends people to PopNow with PKCE S256, the resource and the bots callback", async () => {
    const authorize = await authorizeFor();
    expect(authorize.origin).toBe(h.fake.origin);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.searchParams.get("redirect_uri")).toBe("https://bots.popnow.ai/oauth/callback");
    expect(authorize.searchParams.get("resource")).toBe(h.env.POPNOW_MCP_URL);
    expect(authorize.searchParams.get("scope")).toBe("generate read");
  });

  it("rejects a callback with the wrong state or issuer, then accepts the real one", async () => {
    const authorize = await authorizeFor();
    const consent = await fetch(authorize, { redirect: "manual" });
    const back = new URL(consent.headers.get("location") as string);
    const state = back.searchParams.get("state") as string;
    const code = back.searchParams.get("code") as string;

    const wrongState = await h.call(new Request(`https://bots.popnow.ai/oauth/callback?code=${code}&state=${"z".repeat(32)}&iss=${encodeURIComponent(h.fake.origin)}`));
    expect(wrongState.status).toBe(400);
    const wrongIssuer = await h.call(new Request(`https://bots.popnow.ai/oauth/callback?code=${code}&state=${state}&iss=https%3A%2F%2Fevil.example`));
    expect(wrongIssuer.status).toBe(400);
    expect(await h.kv.get("link:discord:g1:u1")).toBeNull();

    const real = await h.call(new Request(`https://bots.popnow.ai/oauth/callback${back.search}`));
    expect(real.status).toBe(200);
    expect(await h.kv.get("link:discord:g1:u1")).toMatch(/^v1\./);
    // The state is spent.
    const replay = await h.call(new Request(`https://bots.popnow.ai/oauth/callback${back.search}`));
    expect(replay.status).toBe(400);
  });

  it("forgets a Connect link after 15 minutes", async () => {
    const link = await createBindLink(h.env, ref);
    time.now += 16 * 60_000;
    expect((await h.call(new Request(link))).status).toBe(410);
  });

  it("refuses plain http PopNow servers that are not on this computer", async () => {
    expect(() => requireSecure("http://api.popnow.ai/mcp", "the PopNow server")).toThrow(/https/);
    expect(requireSecure("http://127.0.0.1:9/mcp", "x").hostname).toBe("127.0.0.1");
  });

  it("refuses sign-in metadata whose issuer does not match", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(JSON.stringify({ issuer: "https://evil.example", authorization_endpoint: "https://a", token_endpoint: "https://b", registration_endpoint: "https://c" }), {
          headers: { "content-type": "application/json" },
        });
      }
      return real(input, init);
    }) as typeof fetch;
    try {
      await expect(discover(h.env.POPNOW_MCP_URL)).rejects.toThrow(/issuer mismatch/);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("commands", () => {
  it("reads Slack text commands", () => {
    expect(parseText("<@U1> video a dog surfing")).toEqual({ action: "video", input: { prompt: "a dog surfing" } });
    expect(parseText("a cat in a hat")).toEqual({ action: "image", input: { prompt: "a cat in a hat" } });
    expect(parseText("effect Tiny Planet <https://x.com/a.png|a.png>")).toEqual({ action: "effect", input: { link: "https://x.com/a.png", effect: "Tiny Planet" } });
    expect(parseText("")).toEqual({ action: "help", input: {} });
  });

  it("never puts max_credits in a plan", () => {
    const plan = planFor("image", { prompt: "x", aspect: "16:9" });
    expect(plan.args).toEqual({ prompt: "x", aspect_ratio: "16:9" });
  });
});
