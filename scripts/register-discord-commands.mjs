#!/usr/bin/env node
// Registers /popnow from discord/commands.json. Reads everything from the environment; nothing is
// stored in this repository.
//
//   DISCORD_APPLICATION_ID=… DISCORD_BOT_TOKEN=… node scripts/register-discord-commands.mjs
//   DISCORD_GUILD_ID=…  (optional) register in one server only; shows up instantly, for testing
//   DRY_RUN=1           (optional) print what would be sent
import { readFile } from "node:fs/promises";

const appId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;
const guild = process.env.DISCORD_GUILD_ID;
const commands = JSON.parse(await readFile(new URL("../discord/commands.json", import.meta.url), "utf8"));

if (process.env.DRY_RUN) {
  console.log(JSON.stringify(commands, null, 2));
  process.exit(0);
}
if (!appId || !token) {
  console.error("Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN.");
  process.exit(1);
}
const path = guild ? `applications/${appId}/guilds/${guild}/commands` : `applications/${appId}/commands`;
const response = await fetch(`https://discord.com/api/v10/${path}`, {
  method: "PUT",
  headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
  body: JSON.stringify(commands),
});
if (!response.ok) {
  console.error(`Discord answered ${response.status}: ${(await response.text()).slice(0, 500)}`);
  process.exit(1);
}
const saved = await response.json();
console.log(`Registered ${saved.length} command(s)${guild ? " in one server" : " globally"}: ${saved.map((c) => c.name).join(", ")}`);
