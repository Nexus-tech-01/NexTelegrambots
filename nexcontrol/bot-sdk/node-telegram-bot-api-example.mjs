import TelegramBot from "node-telegram-bot-api";
import { NexControlClient } from "./nexcontrol-client.mjs";

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const control = new NexControlClient({
  controlUrl: process.env.NEXCONTROL_URL,
  apiKey: process.env.NEXCONTROL_API_KEY,
  telegramToken: process.env.BOT_TOKEN,
  version: process.env.BOT_VERSION || "dev",
});

bot.on("message", msg => void control.observeUpdate({ message: msg }));
bot.on("channel_post", msg => void control.observeUpdate({ channel_post: msg }));
bot.on("my_chat_member", update => void control.observeUpdate({ my_chat_member: update }));
await control.start();
