import type { Session } from "./oauth.js";
import { clock } from "./env.js";

/**
 * A small Streamable HTTP MCP client for https://api.popnow.ai/mcp (stateless): initialize,
 * notifications/initialized, then tools/call. Replies may come back as JSON or as an event stream.
 * A 401 refreshes the token once. Ported from popnow-cli's src/account/mcp.ts.
 */

const PROTOCOL_VERSION = "2025-06-18";
export const CLIENT_INFO = { name: "popnow-chatbots", version: "0.1.0" };

export interface McpContent {
  type: string;
  text?: string;
  uri?: string;
  resource?: { uri?: string };
}

export interface McpToolResult {
  content?: McpContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export class SignInRequiredError extends Error {
  constructor() {
    super("the PopNow sign-in expired");
    this.name = "SignInRequiredError";
  }
}

async function readReply(response: Response, id: number): Promise<Record<string, unknown>> {
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const messages: unknown[] = [];
  if (type.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) messages.push(JSON.parse(data));
    }
  } else if (text.trim()) {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) messages.push(...parsed);
    else messages.push(parsed);
  }
  const reply = messages.find(
    (message): message is Record<string, unknown> =>
      message !== null && typeof message === "object" && (message as Record<string, unknown>).id === id,
  );
  if (!reply) throw new Error("PopNow sent no reply");
  const error = reply.error as { message?: string } | undefined;
  if (error) throw new Error(error.message ?? "PopNow returned an error");
  return (reply.result ?? {}) as Record<string, unknown>;
}

export interface McpClientOptions {
  session: Session;
  /** Refreshes the session (and saves it); throws when that is not possible. */
  renew: (session: Session) => Promise<Session>;
}

export class McpClient {
  private session: Session;
  private sessionId: string | undefined;
  private protocolVersion = PROTOCOL_VERSION;
  private initialized = false;
  private nextId = 1;

  constructor(private readonly options: McpClientOptions) {
    this.session = options.session;
  }

  get endpoint(): string {
    return this.session.mcpUrl;
  }

  private async renew(): Promise<void> {
    try {
      this.session = await this.options.renew(this.session);
    } catch {
      throw new SignInRequiredError();
    }
  }

  private async post(body: Record<string, unknown>, timeoutMs: number, retried = false): Promise<Response> {
    if (!retried && this.session.expiresAt !== undefined && this.session.expiresAt - 30_000 < clock.now()) {
      await this.renew();
      retried = true;
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.session.accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": this.protocolVersion,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const response = await fetch(this.session.mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 && !retried) {
      await this.renew();
      return this.post(body, timeoutMs, true);
    }
    if (response.status === 401) throw new SignInRequiredError();
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200).trim();
      throw new Error(`PopNow answered ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    return response;
  }

  private async request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this.initialized && method !== "initialize") await this.initialize();
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
    return readReply(response, id);
  }

  private async initialize(): Promise<void> {
    this.initialized = true;
    const result = await this.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      15_000,
    );
    if (typeof result.protocolVersion === "string" && result.protocolVersion) this.protocolVersion = result.protocolVersion;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, 15_000);
  }

  /** Creation tools wait about 40 seconds on the server before handing back a job id. */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<McpToolResult> {
    return (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as McpToolResult;
  }
}

export function textOf(result: McpToolResult): string {
  return (result.content ?? [])
    .filter((item) => item.type === "text" && item.text)
    .map((item) => item.text as string)
    .join("\n")
    .trim();
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export interface JobFile {
  url: string;
  type: string;
  popnowLink?: string;
}

export interface JobView {
  jobId?: string;
  status?: string;
  credits?: number;
  files: JobFile[];
}

export function jobOf(result: McpToolResult): JobView {
  const data = result.structuredContent ?? {};
  const files: JobFile[] = [];
  if (Array.isArray(data.files)) {
    for (const item of data.files as Record<string, unknown>[]) {
      if (typeof item?.url !== "string") continue;
      files.push({
        url: item.url,
        type: typeof item.type === "string" ? item.type : "",
        ...(typeof item.popnow_link === "string" ? { popnowLink: item.popnow_link } : {}),
      });
    }
  }
  const credits = num(data.credits);
  return {
    ...(typeof data.job_id === "string" ? { jobId: data.job_id } : {}),
    ...(typeof data.status === "string" ? { status: data.status } : {}),
    ...(credits === undefined ? {} : { credits }),
    files,
  };
}

export function isDone(status: string | undefined): boolean {
  return status === "succeeded" || status === "failed" || status === "blocked";
}
