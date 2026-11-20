import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readSession } from "../src/accounts.js";
import { completeConnect, discordRequest, harness, time, type Harness, type PlatformCall } from "./helpers.js";

type Json = Record<string, any>;

function command(user: string, sub: string, options: Json[] = [], extra: Json = {}): Json {
  return {
    type: 2,
    token: `itok-${sub}`,
    application_id: "app1",
    guild_id: "g1",
    channel_id: "c1",
    member: { user: { id: user } },
    data: { name: "popnow", options: [{ name: sub, type: 1, options }], ...extra },
  };
}

function press(user: string, customId: string, token = "itok-press"): Json {
  return { type: 3, token, application_id: "app1", guild_id: "g1", channel_id: "c1", member: { user: { id: user } }, data: { custom_id: customId } };
}

const buttonsOf = (data: Json): Json[] => (data.components?.[0]?.components ?? []) as Json[];

describe("Discord", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  const send = async (payload: Json): Promise<Json> => {
    const response = await h.call(await discordRequest(h, payload));
    expect(response.status).toBe(200);
    return (await response.json()) as Json;
  };

  /** Binds user `u` and returns nothing; throws if any step fails. */
  async function bind(user = "u1"): Promise<void> {
    const reply = await send(command(user, "login"));
    expect(reply.data.flags).toBe(64);
    const url = buttonsOf(reply.data)[0]?.url as string;
    expect(url).toMatch(/^https:\/\/bots\.popnow\.ai\/connect\//);
    const done = await completeConnect(h, url);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Connected");
  }

  /** The newest edit of the quote card (PATCH @original or channel message). */
  const lastCard = (): Json => {
    const patch = [...h.platform.calls].reverse().find((c) => c.method === "PATCH");
    return (patch?.json ?? {}) as Json;
  };

  /** Asks for an image as `user` and returns the quote id from the card's Create button. */
  async function quoteImage(user = "u1"): Promise<{ create: string; cancel: string; id: string }> {
    const reply = await send(command(user, "image", [{ name: "prompt", type: 3, value: "a red fox in snow" }]));
    expect(reply).toEqual({ type: 5 });
    await h.ctx.settle();
    await h.jobs.runDue(1_000);
    const card = lastCard();
    const [create, cancel] = buttonsOf(card);
    expect(create?.label).toBe("Create · 48 credits");
    expect(cancel?.label).toBe("Cancel");
    const id = (create?.custom_id as string).split(":")[2] as string;
    return { create: create?.custom_id as string, cancel: cancel?.custom_id as string, id };
  }

  const paidCalls = () => h.fake.calls.filter((c) => c.method === "tools/call" && ["create_image", "create_video", "edit_image", "apply_effect"].includes(c.name ?? ""));

  it("asks people who are not connected to Connect PopNow, only to them", async () => {
    const reply = await send(command("u9", "image", [{ name: "prompt", type: 3, value: "a cat" }]));
    expect(reply.type).toBe(4);
    expect(reply.data.flags).toBe(64);
    expect(buttonsOf(reply.data)[0]).toMatchObject({ style: 5, label: "Connect PopNow" });
    expect(h.fake.calls).toHaveLength(0);
  });

  it("binds with OAuth + PKCE, keeps the tokens sealed, and the link works once", async () => {
    const reply = await send(command("u1", "login"));
    const url = buttonsOf(reply.data)[0]?.url as string;
    await completeConnect(h, url);
    expect(h.fake.registered[0]?.redirect_uris).toEqual(["https://bots.popnow.ai/oauth/callback"]);
    expect(h.fake.registered[0]?.token_endpoint_auth_method).toBe("none");
    expect(h.fake.registered[0]?.scope).toBe("generate read");
    const raw = await h.kv.get("link:discord:g1:u1");
    expect(raw).toMatch(/^v1\./);
    expect(raw).not.toContain("at-1");
    expect((await readSession(h.env, { platform: "discord", workspace: "g1", user: "u1" }))?.accessToken).toBe("at-1");
    // Used once: opening it again shows the expired page.
    const again = await h.call(new Request(url));
    expect(again.status).toBe(410);
    // The client was registered once and reused.
    await bind("u2");
    expect(h.fake.registered).toHaveLength(1);
  });

  it("runs the whole chain: quote, press, start with max_credits, follow the job, post the result", async () => {
    h.fake.sse = false; // plain JSON replies this time
    await bind();
    const { create } = await quoteImage();
    // Pricing used estimate_cost only; nothing was charged yet.
    expect(h.fake.calls.filter((c) => c.method === "tools/call").map((c) => c.name)).toEqual(["estimate_cost"]);
    expect(h.fake.charged).toBe(0);

    const pressed = await send(press("u1", create));
    expect(pressed.type).toBe(7);
    expect(pressed.data.embeds[0].description).toContain("Starting · up to 48 credits");
    expect(buttonsOf(pressed.data)).toHaveLength(0);
    expect(pressed.data.embeds[0].color).toBe(0xe65a2f);

    await h.jobs.runDue(1_000); // start
    const started = paidCalls();
    expect(started).toHaveLength(1);
    expect(started[0]?.args).toMatchObject({ prompt: "a red fox in snow", max_credits: 48 });
    expect(h.fake.charged).toBe(48);

    await h.jobs.runDue(5_000); // get_job: running, then succeeded
    const posted = h.platform.calls.filter((c) => c.method === "POST" && c.url.includes("/webhooks/app1/itok-press"));
    expect(posted).toHaveLength(1);
    expect(posted[0]?.files).toEqual(["files[0]"]);
    expect(posted[0]?.json?.content).toBe("<@u1> Ready.");
    expect(lastCard().embeds[0].description).toContain("Done · 48 credits");
  });

  it("only the person who asked can press the buttons", async () => {
    await bind();
    const { create, cancel } = await quoteImage();
    for (const id of [create, cancel]) {
      const reply = await send(press("someone-else", id));
      expect(reply.type).toBe(4);
      expect(reply.data.flags).toBe(64);
      expect(reply.data.content).toBe("Only the person who asked can use these buttons.");
    }
    await h.jobs.runDue(60_000);
    expect(paidCalls()).toHaveLength(0);
    expect(h.fake.charged).toBe(0);
  });

  it("charges nothing until Create is pressed, and nothing after Cancel", async () => {
    await bind();
    const { cancel, create } = await quoteImage();
    await h.jobs.runDue(10 * 60_000);
    expect(h.fake.charged).toBe(0);
    const canceled = await send(press("u1", cancel));
    expect(canceled.data.embeds[0].description).toContain("Canceled. Nothing was charged.");
    const late = await send(press("u1", create));
    expect(late.data.flags).toBe(64);
    await h.jobs.runDue(60_000);
    expect(paidCalls()).toHaveLength(0);
    expect(h.fake.charged).toBe(0);
  });

  it("pressing Create twice starts one job", async () => {
    await bind();
    const { create } = await quoteImage();
    const [first, second] = await Promise.all([send(press("u1", create, "t1")), send(press("u1", create, "t2"))]);
    const types = [first.type, second.type].sort();
    expect(types).toEqual([4, 7]);
    const again = await send(press("u1", create, "t3"));
    expect(again.data.content).toBe("Already started.");
    await h.jobs.runDue(10_000);
    expect(paidCalls()).toHaveLength(1);
    expect(h.fake.charged).toBe(48);
  });

  it("quotes again when the price went up, and the old button stops working", async () => {
    await bind();
    const { create } = await quoteImage();
    h.fake.prices.create_image = 60;
    await send(press("u1", create));
    await h.jobs.runDue(1_000);
    expect(h.fake.charged).toBe(0);
    const card = lastCard();
    expect(card.embeds[0].description).toContain("Price changed. Nothing was charged.");
    const [newCreate] = buttonsOf(card);
    expect(newCreate?.label).toBe("Create · 60 credits");
    expect(newCreate?.custom_id).not.toBe(create);
    const stale = await send(press("u1", create));
    expect(stale.data.content).toBe("The price changed. Use the newest buttons.");
    await send(press("u1", newCreate?.custom_id as string));
    await h.jobs.runDue(1_000);
    expect(paidCalls().at(-1)?.args?.max_credits).toBe(60);
    expect(h.fake.charged).toBe(60);
  });

  it("quotes again when /mcp answers a price change in text only", async () => {
    h.fake.textOnlyPriceChange = true;
    await bind();
    const { create } = await quoteImage();
    h.fake.prices.create_image = 70;
    await send(press("u1", create));
    await h.jobs.runDue(1_000);
    expect(h.fake.charged).toBe(0);
    expect(buttonsOf(lastCard())[0]?.label).toBe("Create · 70 credits");
  });

  it("uploads an attached photo through an upload window before pricing an edit", async () => {
    await bind();
    const reply = await send(
      command("u1", "edit", [
        { name: "image", type: 11, value: "att1" },
        { name: "prompt", type: 3, value: "make it night" },
      ], {
        resolved: { attachments: { att1: { id: "att1", url: `${h.fake.origin}/files/photo.png`, filename: "photo.png", content_type: "image/png", size: 16 } } },
      }),
    );
    expect(reply).toEqual({ type: 5 });
    await h.ctx.settle();
    await h.jobs.runDue(1_000);
    expect(h.fake.uploads).toEqual([
      "POST /files",
      "file photo.png:16:image/png",
      "PUT /put/f1:16",
      "POST /files/f1/commit",
      "POST /close",
    ]);
    const estimate = h.fake.calls.find((c) => c.name === "estimate_cost");
    expect(estimate?.args).toEqual({ tool: "edit_image", arguments: { prompt: "make it night", image_url: "popnow://f/abc" } });
  });

  it("refuses an attachment that is not a photo", async () => {
    await bind();
    const reply = await send(
      command("u1", "edit", [{ name: "image", type: 11, value: "a" }, { name: "prompt", type: 3, value: "x" }], {
        resolved: { attachments: { a: { id: "a", url: "https://cdn.discordapp.com/x.pdf", filename: "x.pdf", content_type: "application/pdf" } } },
      }),
    );
    expect(reply.data).toMatchObject({ flags: 64, content: "Attach a photo." });
  });

  it("sends a video over 25 MB as a link, and asks for consent from the owner first", async () => {
    h.fake.consent.add("apply_effect");
    await bind();
    await send(
      command("u1", "effect", [{ name: "effect", type: 3, value: "tiny-planet" }, { name: "image", type: 11, value: "a" }], {
        resolved: { attachments: { a: { id: "a", url: `${h.fake.origin}/files/photo.png`, filename: "photo.png", content_type: "image/png" } } },
      }),
    );
    await h.ctx.settle();
    await h.jobs.runDue(1_000);
    const [create] = buttonsOf(lastCard());
    expect(create?.label).toBe("Create · 125 credits");
    await send(press("u1", create?.custom_id as string));
    await h.jobs.runDue(1_000);
    expect(h.fake.charged).toBe(0);
    const consentCard = lastCard();
    expect(consentCard.embeds[0].description).toContain("nobody is under 18");
    const [confirm] = buttonsOf(consentCard);
    expect(confirm?.label).toBe("I confirm");
    const other = await send(press("u2", confirm?.custom_id as string));
    expect(other.data.content).toBe("Only the person who asked can use these buttons.");
    await send(press("u1", confirm?.custom_id as string));
    await h.jobs.runDue(10_000);
    const call = h.fake.calls.filter((c) => c.name === "apply_effect").at(-1);
    expect(call?.args).toMatchObject({ effect: "tiny-planet", image_url: "popnow://f/abc", max_credits: 125, consent: true });
    const posted = h.platform.calls.filter((c: PlatformCall) => c.method === "POST" && c.url.includes("/webhooks/"));
    expect(posted.at(-1)?.files).toEqual([]);
    expect(posted.at(-1)?.json?.content).toContain(`${h.fake.origin}/out/big.mp4`);
  });

  it("refreshes the token once on a 401", async () => {
    await bind();
    h.fake.expire = "at-1";
    await quoteImage();
    expect(h.fake.tokens.refreshed).toBe(1);
    const saved = await readSession(h.env, { platform: "discord", workspace: "g1", user: "u1" });
    expect(saved?.accessToken).toBe("at-r1");
  });

  it("shows Connect again when the refresh is refused, without charging", async () => {
    await bind();
    const session = await readSession(h.env, { platform: "discord", workspace: "g1", user: "u1" });
    h.fake.tokens.valid.clear();
    // A refresh token the fake will not accept.
    const { saveSession } = await import("../src/accounts.js");
    await saveSession(h.env, { platform: "discord", workspace: "g1", user: "u1" }, { ...session!, refreshToken: "bad" });
    await send(command("u1", "image", [{ name: "prompt", type: 3, value: "x" }]));
    await h.ctx.settle();
    await h.jobs.runDue(1_000);
    expect(buttonsOf(lastCard())[0]).toMatchObject({ style: 5, label: "Connect PopNow" });
    expect(h.fake.charged).toBe(0);
  });

  it("logout revokes the tokens and removes the binding", async () => {
    await bind();
    const reply = await send(command("u1", "logout"));
    expect(reply.data.content).toBe("Disconnected from PopNow.");
    await h.ctx.settle();
    expect(h.fake.tokens.revoked).toEqual(["rt-1", "at-1"]);
    expect(await h.kv.get("link:discord:g1:u1")).toBeNull();
    const after = await send(command("u1", "balance"));
    expect(buttonsOf(after.data)[0]?.label).toBe("Connect PopNow");
  });

  it("balance answers only to the asker", async () => {
    await bind();
    const reply = await send(command("u1", "balance"));
    expect(reply).toEqual({ type: 5, data: { flags: 64 } });
    await h.ctx.settle();
    expect(lastCard().content).toBe("You have 5000 PopNow credits.");
  });

  it("autocompletes effects from list_presets", async () => {
    await bind();
    const reply = await send({
      type: 4,
      token: "t",
      application_id: "app1",
      guild_id: "g1",
      member: { user: { id: "u1" } },
      data: { name: "popnow", options: [{ name: "effect", type: 1, options: [{ name: "effect", type: 3, value: "tiny", focused: true }] }] },
    });
    expect(reply).toEqual({ type: 8, data: { choices: [{ name: "Tiny Planet", value: "tiny-planet" }] } });
  });

  it("lets a quote expire after 30 minutes", async () => {
    await bind();
    const { create } = await quoteImage();
    time.now += 31 * 60_000;
    await h.jobs.runDue(0);
    expect(lastCard().embeds[0].description).toContain("This price expired.");
    const late = await send(press("u1", create));
    expect(late.data.flags).toBe(64);
    expect(h.fake.charged).toBe(0);
  });
});
