import {
  chatForVenue,
  formatSignalTelegram,
  formatTelegramTest,
  isTelegramToken,
  parseTelegramVenues,
  sendTelegramText,
  testChatFor,
  type TelegramSignal,
} from "../telegram";
import type { SettingsRow } from "./desk.server";

type TelegramSettings = Pick<SettingsRow, "telegram_bot_token" | "telegram_chat_id" | "telegram_venues">;

/** Sends newly logged signals. Failures stay here so a Telegram outage cannot change the tick. */
export async function notifySignalsTelegram(row: TelegramSettings, venue: string, signals: TelegramSignal[]) {
  if (!signals.length) return;
  const token = (row.telegram_bot_token ?? "").trim();
  if (!isTelegramToken(token)) return;
  const chat = chatForVenue(parseTelegramVenues(row.telegram_venues), venue, row.telegram_chat_id ?? "");
  if (!chat) return;
  const chunk = 4;
  for (let i = 0; i < signals.length; i += chunk) {
    const part = signals.slice(i, i + chunk);
    await Promise.all(part.map((s) => sendTelegramText(token, chat, formatSignalTelegram(venue, s))));
  }
}

export async function sendTelegramTest(row: TelegramSettings, venue: string) {
  const token = (row.telegram_bot_token ?? "").trim();
  if (!isTelegramToken(token)) {
    return { ok: false, message: "توکن ربات ذخیره نشده یا اشتباه است. از BotFather کپی کن و Save بزن." };
  }
  const chat = testChatFor(parseTelegramVenues(row.telegram_venues), venue, row.telegram_chat_id ?? "");
  if (!chat) {
    return { ok: false, message: "چت آیدی کانال نیست. @channel یا عدد -100… را بگذار و Save بزن." };
  }
  const sent = await sendTelegramText(token, chat, formatTelegramTest(venue));
  if (sent.ok) return { ok: true, message: `فرستاده شد به ${chat}` };
  return { ok: false, message: sent.message };
}
