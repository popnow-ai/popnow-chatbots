/** The few web pages this Worker shows: Connect, signed in, installed. Plain HTML, brand colors. */

const STYLE =
  ":root{color-scheme:light dark;--bg:#FAF4E8;--panel:#FFFCF6;--ink:#352242;--line:rgba(53,34,66,.14);--accent:#E65A2F}" +
  "@media (prefers-color-scheme:dark){:root{--bg:#1d1424;--panel:#271c30;--ink:#f3eadf;--line:rgba(243,234,223,.16)}}" +
  "*{box-sizing:border-box}body{font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--ink);display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}" +
  "main{width:100%;max-width:26rem;background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:28px;text-align:center}" +
  "h1{font-size:22px;line-height:1.2;margin:0 0 8px;letter-spacing:-.02em}p{margin:0 0 20px}" +
  "button,.button{display:inline-block;font:inherit;font-weight:700;border:0;border-radius:999px;background:var(--accent);color:#fff;padding:12px 22px;cursor:pointer;text-decoration:none}" +
  ".row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}";

const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function page(title: string, body: string, status = 200): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>PopNow</title><style>${STYLE}</style></head>` +
    `<body><main><h1>${escape(title)}</h1>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'",
    },
  });
}

const APP_NAME = { discord: "Discord", slack: "Slack" } as const;

/**
 * The Connect link opens this page; the link is used up only when the button is pressed (a POST),
 * so link previews in the chat can't spend it.
 */
export function connectPage(platform: "discord" | "slack"): Response {
  return page(
    `Connect PopNow to ${APP_NAME[platform]}`,
    `<p>Create images and videos in ${APP_NAME[platform]} with your PopNow credits.</p>` +
      `<form method="post"><button type="submit">Continue</button></form>`,
  );
}

export const linkUsedPage = (): Response =>
  page("This link has expired", "<p>Go back to the chat and ask PopNow for a new one.</p>", 410);

export const connectedPage = (platform: "discord" | "slack"): Response =>
  page("Connected", `<p>Go back to ${APP_NAME[platform]} to continue. You can close this tab.</p>`);

export const signInFailedPage = (status: number): Response =>
  page("Sign-in did not finish", "<p>Go back to the chat and run login again.</p>", status);

export function homePage(discordUrl: string | undefined, slackUrl: string | undefined): Response {
  const buttons = [
    discordUrl ? `<a class="button" href="${escape(discordUrl)}">Add to Discord</a>` : "",
    slackUrl ? `<a class="button" href="${escape(slackUrl)}">Add to Slack</a>` : "",
  ].join("");
  return page("PopNow for Discord and Slack", `<p>Make images and videos in chat with your PopNow credits.</p><div class="row">${buttons}</div>`);
}

export const installedPage = (): Response =>
  page("PopNow is in your Slack", "<p>Mention @PopNow in a channel to start.</p>");
