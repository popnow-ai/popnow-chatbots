import { finishSignIn, peekBind, startSignIn } from "./accounts.js";
import { discordInstallUrl, handleDiscord } from "./discord.js";
import { configured, type Env, type ExecutionContext } from "./env.js";
import { connectedPage, connectPage, homePage, installedPage, linkUsedPage, page, signInFailedPage } from "./pages.js";
import {
  handleSlackCommand,
  handleSlackEvents,
  handleSlackInteraction,
  slackConnected,
  slackInstallFinish,
  slackInstallRedirect,
} from "./slack.js";

export { PopNowJob } from "./job.js";

/**
 * PopNow for Discord and Slack.
 *
 *   POST /discord/interactions   Discord interactions endpoint (Ed25519)
 *   POST /slack/events           Slack Events API (app_mention, url_verification)
 *   POST /slack/commands         Slack /popnow
 *   POST /slack/interactions     Slack block_actions
 *   GET|POST /connect/<token>    one-time Connect link → PopNow sign-in (OAuth + PKCE)
 *   GET  /oauth/callback         PopNow redirects back here
 *   GET  /slack/install, /slack/oauth, /discord/install
 */
export async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (method === "POST" && pathname === "/discord/interactions") return handleDiscord(request, env, ctx);
  if (method === "POST" && pathname === "/slack/events") return handleSlackEvents(request, env, ctx);
  if (method === "POST" && pathname === "/slack/commands") return handleSlackCommand(request, env, ctx);
  if (method === "POST" && pathname === "/slack/interactions") return handleSlackInteraction(request, env, ctx);

  const connect = /^\/connect\/([A-Za-z0-9_-]{20,64})$/.exec(pathname);
  if (connect?.[1]) {
    const bind = await peekBind(env, connect[1]);
    if (!bind) return linkUsedPage();
    if (method === "GET") return connectPage(bind.ref.platform);
    if (method === "POST") {
      const next = await startSignIn(env, connect[1]);
      return next ? Response.redirect(next, 302) : linkUsedPage();
    }
  }

  if (method === "GET" && pathname === "/oauth/callback") {
    const outcome = await finishSignIn(env, url.searchParams);
    if (!outcome.ok) return signInFailedPage(outcome.status);
    if (outcome.ref.platform === "slack") ctx.waitUntil(slackConnected(env, outcome.ref).catch(() => undefined));
    return connectedPage(outcome.ref.platform);
  }

  if (method === "GET" && pathname === "/slack/install") return slackInstallRedirect(env);
  if (method === "GET" && pathname === "/slack/oauth") {
    return (await slackInstallFinish(env, url.searchParams)) ? installedPage() : page("Install did not finish", "<p>Try adding PopNow to Slack again.</p>", 400);
  }
  if (method === "GET" && pathname === "/discord/install") {
    const target = discordInstallUrl(env);
    return target ? Response.redirect(target, 302) : new Response("Discord is not set up", { status: 404 });
  }
  if (method === "GET" && pathname === "/") {
    const base = env.PUBLIC_URL.replace(/\/$/, "");
    return homePage(configured(env.DISCORD_APPLICATION_ID) ? `${base}/discord/install` : undefined, configured(env.SLACK_CLIENT_ID) ? `${base}/slack/install` : undefined);
  }
  return new Response("not found", { status: 404 });
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(request, env, ctx).catch((error: unknown) => {
      console.error(`request failed: ${error instanceof Error ? error.name : "error"}`);
      return new Response("Something went wrong", { status: 500 });
    });
  },
};
