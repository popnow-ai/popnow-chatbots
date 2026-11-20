import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { open, seal } from "../src/crypto.js";
import { discordRequest, harness, slackRequest, type Harness } from "./helpers.js";

describe("request signatures", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  it("Discord: a correct Ed25519 signature passes and PING gets PONG", async () => {
    const response = await h.call(await discordRequest(h, { type: 1, token: "t", application_id: "app1" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 1 });
  });

  it("Discord: a wrong signature is refused", async () => {
    const response = await h.call(await discordRequest(h, { type: 1 }, { tamper: true }));
    expect(response.status).toBe(401);
  });

  it("Discord: a request older than 5 minutes is refused", async () => {
    const response = await h.call(await discordRequest(h, { type: 1 }, { age: 301 }));
    expect(response.status).toBe(401);
  });

  it("Slack: a correct v0 signature passes url_verification", async () => {
    const response = await h.call(await slackRequest(h, "/slack/events", JSON.stringify({ type: "url_verification", challenge: "abc" })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "abc" });
  });

  it("Slack: a wrong signature is refused", async () => {
    const response = await h.call(
      await slackRequest(h, "/slack/events", JSON.stringify({ type: "url_verification", challenge: "abc" }), { secret: "not-it" }),
    );
    expect(response.status).toBe(401);
  });

  it("Slack: a timestamp more than 5 minutes old is refused", async () => {
    const response = await h.call(
      await slackRequest(h, "/slack/events", JSON.stringify({ type: "url_verification", challenge: "abc" }), { age: 301 }),
    );
    expect(response.status).toBe(401);
  });
});

describe("token sealing", () => {
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

  it("opens only with the same key and the same KV key", async () => {
    const sealed = await seal(key, "secret-token", "link:discord:g1:u1");
    expect(sealed).not.toContain("secret-token");
    expect(await open(key, sealed, "link:discord:g1:u1")).toBe("secret-token");
    expect(await open(key, sealed, "link:discord:g1:u2")).toBeUndefined();
    const other = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    expect(await open(other, sealed, "link:discord:g1:u1")).toBeUndefined();
  });
});
