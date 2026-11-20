import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { completeConnect, harness, slackRequest, type Harness, type PlatformCall } from "./helpers.js";

type Json = Record<string, any>;

function mention(user: string, text: string, eventId = `Ev${Math.random().toString(36).slice(2, 10)}`, thread?: string): string {
  return JSON.stringify({
    type: "event_callback",
    team_id: "T1",
    event_id: eventId,
    event: { type: "app_mention", user, text: `<@UBOT> ${text}`, channel: "C1", ts: "1699.0001", ...(thread ? { thread_ts: thread } : {}) },
  });
}

function click(user: string, actionId: string, value: string): string {
  const payload = {
    type: "block_actions",
    user: { id: user, team_id: "T1" },
    team: { id: "T1" },
    channel: { id: "C1" },
    response_url: "https://hooks.slack.com/actions/T1/1/abc",
    actions: [{ action_id: actionId, value }],
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

describe("Slack", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  const slack = (method: string): PlatformCall[] => h.platform.calls.filter((c) => c.url === `https://slack.com/api/${method}`);
  const buttons = (call: PlatformCall | undefined): Json[] => {
    const blocks = ((call?.json?.attachments as Json[] | undefined)?.[0]?.blocks ?? call?.json?.blocks ?? []) as Json[];
    return (blocks.find((b) => b.type === "actions")?.elements ?? []) as Json[];
  };

  async function post(path: "/slack/events" | "/slack/commands" | "/slack/interactions", body: string, headers?: Record<string, string>): Promise<Response> {
    const response = await h.call(await slackRequest(h, path, body, headers ? { headers } : {}));
    await h.ctx.settle();
    return response;
  }

  async function bind(user = "U1"): Promise<void> {
    await post("/slack/events", mention(user, "login"));
    const ephemeral = slack("chat.postEphemeral").at(-1);
    const [authorize] = buttons(ephemeral);
    expect(authorize?.text?.text).toBe("Authorize");
    const done = await completeConnect(h, authorize?.url as string);
    expect(done.status).toBe(200);
    await h.ctx.settle();
  }

  it("answers a mention from someone not connected with an Authorize button only they see", async () => {
    const response = await post("/slack/events", mention("U9", "a fox in the snow", "Ev1", "1690.5"));
    expect(response.status).toBe(200);
    const ephemeral = slack("chat.postEphemeral");
    expect(ephemeral).toHaveLength(1);
    expect(ephemeral[0]?.json).toMatchObject({ channel: "C1", user: "U9", thread_ts: "1690.5" });
    expect(buttons(ephemeral[0])[0]).toMatchObject({ text: { text: "Authorize" } });
    expect(h.fake.calls).toHaveLength(0);
  });

  it("handles each event once and acknowledges Slack's retries without work", async () => {
    await post("/slack/events", mention("U9", "a fox", "EvSame"));
    await post("/slack/events", mention("U9", "a fox", "EvSame"));
    expect(slack("chat.postEphemeral")).toHaveLength(1);
    const retry = await post("/slack/events", mention("U9", "a fox", "EvOther"), { "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout" });
    expect(retry.status).toBe(200);
    expect(slack("chat.postEphemeral")).toHaveLength(1);
  });

  it("binds, then says hello in a DM", async () => {
    await bind();
    expect(await h.kv.get("link:slack:T1:U1")).toMatch(/^v1\./);
    expect(slack("conversations.open")[0]?.json).toEqual({ users: "U1" });
    expect(slack("chat.postMessage").at(-1)?.json?.channel).toBe("D1");
  });

  it("quotes in the thread, starts on the owner's press and uploads the result to the thread", async () => {
    await bind();
    await post("/slack/events", mention("U1", "video a dog surfing", "Ev2", "1690.5"));
    await h.jobs.runDue(1_000);
    const card = slack("chat.postMessage").at(-1);
    expect(card?.json).toMatchObject({ channel: "C1", thread_ts: "1690.5" });
    expect((card?.json?.attachments as Json[])[0]?.color).toBe("#E65A2F");
    const [create] = buttons(card);
    expect(create).toMatchObject({ text: { text: "Create · 185 credits" }, style: "primary", action_id: "pn_create" });
    expect(h.fake.charged).toBe(0);

    // Someone else presses: told privately, nothing starts.
    await post("/slack/interactions", click("U2", "pn_create", create?.value as string));
    const hook = h.platform.calls.filter((c) => c.url.startsWith("https://hooks.slack.com/")).at(-1);
    expect(hook?.json).toMatchObject({ response_type: "ephemeral", text: "Only the person who asked can use these buttons." });
    await h.jobs.runDue(5_000);
    expect(h.fake.charged).toBe(0);

    const response = await post("/slack/interactions", click("U1", "pn_create", create?.value as string));
    expect(response.status).toBe(200);
    expect(slack("chat.update").at(-1)?.json).toMatchObject({ channel: "C1", ts: "1700.0001" });
    await h.jobs.runDue(10_000);
    const started = h.fake.calls.filter((c) => c.name === "create_video");
    expect(started).toHaveLength(1);
    expect(started[0]?.args).toMatchObject({ prompt: "a dog surfing", max_credits: 185 });
    // The video is 26 MB: under Slack's limit here, so it is uploaded to the thread.
    expect(slack("files.getUploadURLExternal")[0]?.form).toMatchObject({ filename: "popnow-1.mp4", length: String(26 * 1024 * 1024) });
    expect(slack("files.completeUploadExternal")[0]?.form).toMatchObject({ channel_id: "C1", thread_ts: "1690.5", initial_comment: "<@U1> Ready." });
    const updates = slack("chat.update");
    const lastText = JSON.stringify(updates.at(-1)?.json);
    expect(lastText).toContain("Done · 185 credits");
  });

  it("a second press does not start a second job", async () => {
    await bind();
    await post("/slack/events", mention("U1", "image a red fox", "Ev3"));
    await h.jobs.runDue(1_000);
    const [create] = buttons(slack("chat.postMessage").at(-1));
    await Promise.all([
      post("/slack/interactions", click("U1", "pn_create", create?.value as string)),
      post("/slack/interactions", click("U1", "pn_create", create?.value as string)),
    ]);
    await h.jobs.runDue(10_000);
    expect(h.fake.calls.filter((c) => c.name === "create_image")).toHaveLength(1);
    expect(h.fake.charged).toBe(48);
    const told = h.platform.calls.filter((c) => c.url.startsWith("https://hooks.slack.com/")).map((c) => c.json?.text);
    expect(told).toContain("Already started.");
  });

  it("/popnow in a channel the bot is not in falls back to the command's reply address", async () => {
    await bind();
    h.platform.failChannelPost.value = true;
    const form = new URLSearchParams({
      command: "/popnow",
      text: "image a lighthouse at dusk --ar 16:9",
      team_id: "T1",
      user_id: "U1",
      channel_id: "C7",
      response_url: "https://hooks.slack.com/commands/T1/2/xyz",
    }).toString();
    const response = await post("/slack/commands", form);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    await h.jobs.runDue(1_000);
    expect(h.fake.calls.find((c) => c.name === "estimate_cost")?.args).toEqual({
      tool: "create_image",
      arguments: { prompt: "a lighthouse at dusk", aspect_ratio: "16:9" },
    });
    const viaHook = h.platform.calls.filter((c) => c.url === "https://hooks.slack.com/commands/T1/2/xyz").at(-1);
    expect(viaHook?.json).toMatchObject({ response_type: "in_channel" });
    expect(buttons(viaHook)[0]?.text?.text).toBe("Create · 48 credits");
  });

  it("asks for an image link when edit has none", async () => {
    await bind();
    await post("/slack/events", mention("U1", "edit make it night", "Ev4"));
    expect(slack("chat.postEphemeral").at(-1)?.json?.text).toBe("Add a photo. Paste an image link (https:// or popnow://).");
  });

  it("passes a pasted image link straight to the tool", async () => {
    await bind();
    await post("/slack/events", mention("U1", "edit <https://example.com/cat.png> make it night", "Ev5"));
    await h.jobs.runDue(1_000);
    expect(h.fake.calls.find((c) => c.name === "estimate_cost")?.args).toEqual({
      tool: "edit_image",
      arguments: { prompt: "make it night", image_url: "https://example.com/cat.png" },
    });
  });

  it("logout revokes the tokens", async () => {
    await bind();
    await post("/slack/events", mention("U1", "logout", "Ev6"));
    expect(h.fake.tokens.revoked).toEqual(["rt-1", "at-1"]);
    expect(await h.kv.get("link:slack:T1:U1")).toBeNull();
  });

  it("installs into a workspace and keeps its bot token sealed", async () => {
    const start = await h.call(new Request("https://bots.popnow.ai/slack/install"));
    expect(start.status).toBe(302);
    const target = new URL(start.headers.get("location") as string);
    expect(target.searchParams.get("scope")).toBe("app_mentions:read,chat:write,commands,files:write,im:write");
    const state = target.searchParams.get("state") as string;
    const bad = await h.call(new Request(`https://bots.popnow.ai/slack/oauth?code=c&state=${"x".repeat(32)}`));
    expect(bad.status).toBe(400);
    const done = await h.call(new Request(`https://bots.popnow.ai/slack/oauth?code=c&state=${state}`));
    expect(done.status).toBe(200);
    const sealed = await h.kv.get("slack:team:T9");
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("xoxb-installed");
  });
});
