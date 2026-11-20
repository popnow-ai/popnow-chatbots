import { clientFor, createBindLink } from "./accounts.js";
import { REPLIES, type ButtonKind, type Card, type Stage } from "./cards.js";
import { TITLES, type Plan } from "./commands.js";
import { clock, sameUser, type DurableObjectState, type Env, type UserRef } from "./env.js";
import { isDone, jobOf, num, SignInRequiredError, textOf, type JobFile, type McpClient, type McpToolResult } from "./mcp.js";
import { surfaceFor, type SurfaceContext } from "./surfaces.js";
import { uploadChatFiles, UploadTooLargeError } from "./upload.js";

/**
 * One Durable Object per quote. It is the only place a job is started, so a button pressed twice
 * (or on two devices) starts one job. It prices the request, waits for the owner's press, starts
 * the job with max_credits set to the price on the button, follows it with get_job on an alarm
 * and posts the result back into the chat.
 */

export const QUOTE_TTL_MS = 30 * 60_000;
export const POLL_FOR_MS = 45 * 60_000;
const POLL_EVERY_MS = 2_000;

type Step = "quote" | "start" | "poll" | "expire" | "idle";

export interface JobRecord {
  id: string;
  rev: number;
  stage: Stage;
  step: Step;
  owner: UserRef;
  plan: Plan;
  surface: SurfaceContext;
  credits?: number;
  balance?: number;
  consent?: boolean;
  jobId?: string;
  note?: string;
  connectUrl?: string;
  createdAt: number;
  quotedAt?: number;
  pollUntil?: number;
  attempts: number;
  delivered?: boolean;
}

export interface OpenRequest {
  id: string;
  owner: UserRef;
  plan: Plan;
  surface: SurfaceContext;
}

export interface ClickRequest {
  kind: ButtonKind;
  rev: number;
  user: UserRef;
  /** Fresh reply details from the click (a new Discord interaction token). */
  surface?: Partial<SurfaceContext>;
}

export interface ClickReply {
  card?: Card;
  surface?: SurfaceContext;
  /** Shown only to whoever pressed. */
  reply?: string;
}

export function cardOf(record: JobRecord): Card {
  return {
    id: record.id,
    rev: record.rev,
    stage: record.stage,
    title: TITLES[record.plan.action],
    summary: record.plan.summary,
    owner: record.owner,
    ...(record.credits === undefined ? {} : { credits: record.credits }),
    ...(record.balance === undefined ? {} : { balance: record.balance }),
    ...(record.note === undefined ? {} : { note: record.note }),
    ...(record.connectUrl === undefined ? {} : { connectUrl: record.connectUrl }),
  };
}

function firstLine(text: string, fallback: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return fallback;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

export class PopNowJob {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  private load(): Promise<JobRecord | undefined> {
    return this.state.storage.get<JobRecord>("job");
  }

  private save(record: JobRecord): Promise<void> {
    return this.state.storage.put("job", record);
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/open") return json(await this.open((await request.json()) as OpenRequest));
    if (request.method === "POST" && path === "/click") return json(await this.click((await request.json()) as ClickRequest));
    if (request.method === "GET" && path === "/card") {
      const record = await this.load();
      return record ? json(cardOf(record)) : json({}, 404);
    }
    return new Response("not found", { status: 404 });
  }

  private async open(input: OpenRequest): Promise<{ ok: boolean }> {
    return this.state.blockConcurrencyWhile(async () => {
      if (await this.load()) return { ok: true }; // the same command delivered twice
      const record: JobRecord = {
        id: input.id,
        rev: 1,
        stage: "quoting",
        step: "quote",
        owner: input.owner,
        plan: input.plan,
        surface: input.surface,
        createdAt: clock.now(),
        attempts: 0,
      };
      await this.save(record);
      // A moment's delay so the chat has shown the deferred reply before we edit it.
      await this.state.storage.setAlarm(clock.now() + 300);
      return { ok: true };
    });
  }

  private async click(input: ClickRequest): Promise<ClickReply> {
    return this.state.blockConcurrencyWhile(async () => {
      const record = await this.load();
      if (!record) return { reply: REPLIES.gone };
      if (!sameUser(record.owner, input.user)) return { reply: REPLIES.notOwner };
      if (input.surface) record.surface = { ...record.surface, ...input.surface } as SurfaceContext;
      const waiting = record.stage === "quoted" || record.stage === "short" || record.stage === "consent";

      if (input.kind === "cancel") {
        if (!waiting) {
          await this.save(record);
          return { reply: record.stage === "starting" || record.stage === "running" ? REPLIES.started : REPLIES.finished };
        }
        record.stage = "canceled";
        record.step = "idle";
        await this.save(record);
        await this.state.storage.deleteAlarm();
        return { card: cardOf(record), surface: record.surface };
      }

      const expected: Stage = input.kind === "consent" ? "consent" : "quoted";
      if (record.stage !== expected) {
        await this.save(record);
        if (record.stage === "starting" || record.stage === "running") return { reply: REPLIES.started };
        if (waiting) return { reply: REPLIES.stale };
        return { reply: record.stage === "expired" ? REPLIES.gone : REPLIES.finished };
      }
      if (input.rev !== record.rev) {
        await this.save(record);
        return { reply: REPLIES.stale };
      }
      if (record.quotedAt !== undefined && clock.now() - record.quotedAt > QUOTE_TTL_MS) {
        record.stage = "expired";
        record.step = "idle";
        await this.save(record);
        return { card: cardOf(record), surface: record.surface };
      }
      if (input.kind === "consent") record.consent = true;
      record.stage = "starting";
      record.step = "start";
      record.attempts = 0;
      delete record.note;
      await this.save(record);
      await this.state.storage.setAlarm(clock.now());
      return { card: cardOf(record), surface: record.surface };
    });
  }

  async alarm(): Promise<void> {
    const record = await this.load();
    if (!record) return;
    try {
      switch (record.step) {
        case "quote":
          await this.quote(record);
          break;
        case "start":
          await this.start(record);
          break;
        case "poll":
          await this.poll(record);
          break;
        case "expire":
          if (record.stage === "quoted" || record.stage === "short" || record.stage === "consent") {
            record.stage = "expired";
            record.step = "idle";
            await this.save(record);
            await this.show(record);
          }
          break;
        case "idle":
          break;
      }
    } catch (error) {
      // Never rethrow: a retried alarm must not start a job twice.
      console.error(`job ${record.id} ${record.step}: ${error instanceof Error ? error.name : "error"}`);
    }
  }

  private async show(record: JobRecord): Promise<void> {
    try {
      await surfaceFor(this.env, record.surface).showCard(cardOf(record), record.surface);
    } finally {
      await this.save(record); // the surface may have learned a message id
    }
  }

  private async client(record: JobRecord): Promise<McpClient | undefined> {
    const client = await clientFor(this.env, record.owner);
    if (!client) await this.needSignIn(record);
    return client;
  }

  private async needSignIn(record: JobRecord): Promise<void> {
    record.stage = "signin";
    record.step = "idle";
    record.connectUrl = await createBindLink(this.env, record.owner);
    await this.show(record);
  }

  private async fail(record: JobRecord, note: string): Promise<void> {
    record.stage = "failed";
    record.step = "idle";
    record.note = note;
    await this.show(record);
  }

  /** Prices the request with estimate_cost (free, creates nothing) and shows the buttons. */
  private async price(record: JobRecord, client: McpClient, note?: string): Promise<boolean> {
    const estimate = await client.callTool("estimate_cost", { tool: record.plan.tool, arguments: record.plan.args }, 30_000);
    const data = estimate.structuredContent ?? {};
    const quoted = num(data.credits);
    if (estimate.isError || quoted === undefined) {
      await this.fail(record, firstLine(textOf(estimate), "Couldn't get a price."));
      return false;
    }
    const balance = num(data.balance);
    record.credits = quoted;
    if (balance === undefined) delete record.balance;
    else record.balance = balance;
    record.stage = balance !== undefined && quoted > balance ? "short" : "quoted";
    if (note === undefined) delete record.note;
    else record.note = note;
    record.quotedAt = clock.now();
    record.step = "expire";
    await this.show(record);
    await this.state.storage.setAlarm(record.quotedAt + QUOTE_TTL_MS);
    return true;
  }

  private async quote(record: JobRecord): Promise<void> {
    const client = await this.client(record);
    if (!client) return;
    try {
      if (record.plan.file && record.plan.mediaKey) {
        const [link] = await uploadChatFiles(client, [record.plan.file], "From PopNow chat");
        record.plan.args[record.plan.mediaKey] = link;
        delete record.plan.file;
        await this.save(record);
      }
      await this.price(record, client);
    } catch (error) {
      if (error instanceof SignInRequiredError) return this.needSignIn(record);
      if (error instanceof UploadTooLargeError) return this.fail(record, "That file is too big. Keep it under 50 MB.");
      record.attempts++;
      if (record.attempts >= 3) return this.fail(record, "PopNow didn't answer. Try again in a minute.");
      await this.save(record);
      await this.state.storage.setAlarm(clock.now() + 5_000 * record.attempts);
    }
  }

  /** Starts the job, capped at the price on the button. Never retried blindly. */
  private async start(record: JobRecord): Promise<void> {
    const client = await this.client(record);
    if (!client) return;
    const cap = record.credits ?? 0;
    const args: Record<string, unknown> = { ...record.plan.args, max_credits: cap };
    if (record.consent) args.consent = true;
    let result: McpToolResult;
    try {
      result = await client.callTool(record.plan.tool, args);
    } catch (error) {
      if (error instanceof SignInRequiredError) return this.needSignIn(record);
      // It may have started: send people to their creations rather than risk a second job.
      return this.fail(record, "PopNow didn't answer. Check /popnow creations before you try again.");
    }
    const data = result.structuredContent ?? {};
    if (data.needs_consent === true && !record.consent) {
      record.stage = "consent";
      record.step = "expire";
      record.quotedAt = clock.now();
      await this.show(record);
      await this.state.storage.setAlarm(record.quotedAt + QUOTE_TTL_MS);
      return;
    }
    const job = jobOf(result);
    if (job.jobId) {
      if (job.credits !== undefined) record.credits = job.credits;
      record.jobId = job.jobId;
      if (isDone(job.status)) return this.finish(record, result);
      record.stage = "running";
      record.step = "poll";
      record.pollUntil = clock.now() + POLL_FOR_MS;
      record.attempts = 0;
      await this.show(record);
      await this.state.storage.setAlarm(clock.now() + POLL_EVERY_MS);
      return;
    }
    if (data.needs_confirmation === true || (!result.isError && !job.jobId)) {
      // The price moved past the cap. Nothing started; quote again and wait for a new press.
      record.rev++;
      record.note = "Price changed. Nothing was charged.";
      const quoted = num(data.credits);
      const balance = num(data.balance);
      if (quoted !== undefined && quoted > cap) {
        record.credits = quoted;
        if (balance !== undefined) record.balance = balance;
        record.stage = balance !== undefined && quoted > balance ? "short" : "quoted";
        record.quotedAt = clock.now();
        record.step = "expire";
        await this.show(record);
        await this.state.storage.setAlarm(record.quotedAt + QUOTE_TTL_MS);
        return;
      }
      await this.price(record, client, record.note);
      return;
    }
    return this.fail(record, firstLine(textOf(result), "It didn't work."));
  }

  private async poll(record: JobRecord): Promise<void> {
    if (!record.jobId) return;
    const client = await this.client(record);
    if (!client) return;
    let result: McpToolResult;
    try {
      result = await client.callTool("get_job", { job_id: record.jobId, wait_seconds: 20 }, 60_000);
    } catch (error) {
      if (error instanceof SignInRequiredError) return this.needSignIn(record);
      record.attempts++;
      await this.save(record);
      if (record.attempts < 10) await this.state.storage.setAlarm(clock.now() + 10_000);
      else await this.stillRunning(record);
      return;
    }
    const job = jobOf(result);
    if (isDone(job.status)) return this.finish(record, result);
    if (clock.now() > (record.pollUntil ?? 0)) return this.stillRunning(record);
    await this.save(record);
    await this.state.storage.setAlarm(clock.now() + POLL_EVERY_MS);
  }

  private async stillRunning(record: JobRecord): Promise<void> {
    record.step = "idle";
    record.note = "Still making it. Find it in /popnow creations.";
    await this.show(record);
  }

  private async finish(record: JobRecord, result: McpToolResult): Promise<void> {
    const job = jobOf(result);
    if (job.status !== "succeeded") {
      const reason = firstLine(textOf(result), "It didn't work.");
      return this.fail(record, /refund/i.test(reason) ? reason : `${reason} Failed creations are refunded.`);
    }
    if (job.credits !== undefined) record.credits = job.credits;
    record.stage = "done";
    record.step = "idle";
    await this.show(record);
    if (record.delivered) return;
    record.delivered = true;
    await this.save(record);
    await surfaceFor(this.env, record.surface).deliver(cardOf(record), record.surface, job.files as JobFile[]);
    await this.save(record);
  }
}
