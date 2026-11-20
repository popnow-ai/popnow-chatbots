import type { McpClient } from "./mcp.js";

/**
 * Puts files from a chat (already downloaded) into the user's PopNow account and returns their
 * popnow:// links, in order. Same upload window as popnow-cli: request_upload, then the window's
 * public endpoints (no Authorization on the signed storage address), then get_upload.
 */

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface ChatFile {
  /** A link the platform gave us (Discord CDN). Downloaded without any of our credentials. */
  url: string;
  name: string;
  contentType: string;
  size?: number;
}

export function kindOf(contentType: string): "image" | "video" | "audio" | undefined {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  return undefined;
}

async function envelope(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as { code?: number; msg?: string; data?: unknown };
  if (!response.ok || body.code !== 200) throw new Error(body.msg ? `upload failed: ${body.msg}` : `upload failed (${response.status})`);
  return (body.data ?? {}) as Record<string, unknown>;
}

async function download(file: ChatFile): Promise<Uint8Array<ArrayBuffer>> {
  if (file.size !== undefined && file.size > MAX_UPLOAD_BYTES) throw new UploadTooLargeError();
  const response = await fetch(file.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`could not download ${file.name} (${response.status})`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_UPLOAD_BYTES) throw new UploadTooLargeError();
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_UPLOAD_BYTES) throw new UploadTooLargeError();
  return bytes;
}

export class UploadTooLargeError extends Error {
  constructor() {
    super("file too large");
    this.name = "UploadTooLargeError";
  }
}

export async function uploadChatFiles(client: McpClient, files: readonly ChatFile[], note: string): Promise<string[]> {
  if (files.length === 0) return [];
  if (files.length > 10) throw new TypeError("at most 10 files at once");
  const kinds = [...new Set(files.map((file) => kindOf(file.contentType) ?? "image"))];
  const opened = await client.callTool("request_upload", { kinds, max_files: files.length, note }, 30_000);
  const data = opened.structuredContent ?? {};
  const uploadId = typeof data.upload_id === "string" ? data.upload_id : undefined;
  const pageUrl = typeof data.url === "string" ? data.url : undefined;
  if (!uploadId || !pageUrl) throw new Error("PopNow did not open an upload window");
  const token = new URL(pageUrl).pathname.split("/").filter(Boolean).at(-1) ?? "";
  const api = `${new URL(client.endpoint).origin}/console/v1/upload-sessions/${encodeURIComponent(token)}`;
  const post = (path: string, body?: unknown): Promise<Response> =>
    fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });

  const names: string[] = [];
  for (const file of files) {
    const bytes = await download(file);
    const name = file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
    names.push(name);
    const ticket = await envelope(await post("/files", { contentType: file.contentType, bytes: bytes.length, name }));
    const uploadUrl = ticket.uploadUrl;
    const fileId = ticket.fileId;
    if (typeof uploadUrl !== "string" || typeof fileId !== "string") throw new Error("upload failed: no upload address");
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((ticket.headers ?? {}) as Record<string, string>)) {
      if (!/^(content-length|host|authorization)$/i.test(key)) headers[key] = value;
    }
    const put = await fetch(uploadUrl, {
      method: typeof ticket.method === "string" ? ticket.method : "PUT",
      headers,
      body: bytes,
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (!put.ok) throw new Error(`upload of ${name} failed (${put.status})`);
    await envelope(await post(`/files/${encodeURIComponent(fileId)}/commit`));
  }
  await post("/close").then(envelope).catch(() => undefined);

  const result = await client.callTool("get_upload", { upload_id: uploadId, wait_seconds: 0 }, 30_000);
  const listed = Array.isArray(result.structuredContent?.files)
    ? (result.structuredContent.files as { popnow_link?: unknown; name?: unknown }[])
    : [];
  const links: string[] = [];
  const unused = [...listed];
  for (const name of names) {
    const at = unused.findIndex((item) => item.name === name);
    const item = at >= 0 ? unused.splice(at, 1)[0] : unused.shift();
    if (!item || typeof item.popnow_link !== "string") throw new Error(`PopNow did not return a link for ${name}`);
    links.push(item.popnow_link);
  }
  return links;
}
