import { Telegraf } from "telegraf";
import { NexControlClient } from "./nexcontrol-client.mjs";

const bot = new Telegraf(process.env.BOT_TOKEN);
const control = new NexControlClient({
  controlUrl: process.env.NEXCONTROL_URL,
  apiKey: process.env.NEXCONTROL_API_KEY,
  telegramToken: process.env.BOT_TOKEN,
  version: process.env.BOT_VERSION || "dev",
});

// Observe every update without blocking normal command handling.
bot.use(async (ctx, next) => {
  void control.observeUpdate(ctx.update);
  return next();
});

await control.start();
await bot.launch();
