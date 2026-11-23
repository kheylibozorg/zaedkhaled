export const TELEGRAM_VENUE_IDS = ["paper", "hyperliquid", "lighter", "aster", "ourbit"] as const;
export type TelegramVenueId = (typeof TELEGRAM_VENUE_IDS)[number];

export type TelegramVenuePref = { on: boolean; chatId: string };
export type TelegramVenueMap = Record<TelegramVenueId, TelegramVenuePref>;

export type TelegramSignal = {
  symbol: string;
  timeframe: string;
  indicator: string;
  side: string;
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  reason: string;
  taken: boolean;
  queued?: boolean;
  skip: string;
};

const VENUE_LABEL: Record<TelegramVenueId, string> = {
  paper: "Paper",
  aster: "Aster",
  hyperliquid: "Hyperliquid",
  lighter: "Lighter",
  ourbit: "OURBIT",
};

/** Same book ids as bookVenue(), including the old toobit name. */
export function telegramVenueId(venue: string): TelegramVenueId {
  if (venue === "toobit" || venue === "ourbit") return "ourbit";
  if (venue === "hyperliquid" || venue === "lighter" || venue === "aster" || venue === "paper") return venue;
  return "paper";
}

const EMPTY_PREF: TelegramVenuePref = { on: false, chatId: "" };

export function emptyTelegramVenues(): TelegramVenueMap {
  return {
    paper: { ...EMPTY_PREF },
    hyperliquid: { ...EMPTY_PREF },
    lighter: { ...EMPTY_PREF },
    aster: { ...EMPTY_PREF },
    ourbit: { ...EMPTY_PREF },
  };
}

export function isTelegramToken(token: string) {
  return /^\d{6,15}:[A-Za-z0-9_-]{20,}$/.test(token.trim());
}

/** @channel for a public channel, or a numeric id such as -100… */
export function isTelegramChatId(chatId: string) {
  return /^(@[A-Za-z][A-Za-z0-9_]{3,31}|-?\d{5,20})$/.test(chatId.trim());
}

export function parseTelegramVenues(raw: string | null | undefined): TelegramVenueMap {
  const out = emptyTelegramVenues();
  if (!raw || !raw.trim()) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  const bag = parsed as Record<string, unknown>;
  for (const id of TELEGRAM_VENUE_IDS) {
    const v = bag[id];
    if (typeof v === "boolean") {
      out[id] = { on: v, chatId: "" };
      continue;
    }
    if (!v || typeof v !== "object") continue;
    const row = v as { on?: unknown; chatId?: unknown };
    const chatId = typeof row.chatId === "string" ? row.chatId.trim().slice(0, 64) : "";
    out[id] = { on: Boolean(row.on), chatId };
  }
  return out;
}

export function stringifyTelegramVenues(map: Partial<Record<string, TelegramVenuePref>> | null | undefined) {
  const clean = emptyTelegramVenues();
  for (const id of TELEGRAM_VENUE_IDS) {
    const v = map?.[id];
    clean[id] = {
      on: Boolean(v?.on),
      chatId: typeof v?.chatId === "string" ? v.chatId.trim().slice(0, 64) : "",
    };
  }
  return JSON.stringify(clean);
}

/** Chat used for live signals. Null when the venue toggle is off or no valid chat is set. */
export function chatForVenue(prefs: TelegramVenueMap, venue: string, fallbackChat: string) {
  const id = telegramVenueId(venue);
  const pref = prefs[id];
  if (!pref?.on) return null;
  const chat = (pref.chatId || fallbackChat || "").trim();
  if (!isTelegramChatId(chat)) return null;
  return chat;
}

/** Chat used by the test button. Does not require the venue toggle. */
export function testChatFor(prefs: TelegramVenueMap, venue: string, fallbackChat: string) {
  const id = telegramVenueId(venue);
  const chat = (prefs[id]?.chatId || fallbackChat || "").trim();
  if (!isTelegramChatId(chat)) return null;
  return chat;
}

export function fmtPx(n: number) {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
  const text = n.toFixed(digits).replace(/\.?0+$/, "");
  return text === "-0" ? "0" : text;
}

export function formatSignalTelegram(venue: string, s: TelegramSignal) {
  const side = s.side.toLowerCase() === "short" ? "شورت" : "لانگ";
  const lines = [
    `سیگنال · ${VENUE_LABEL[telegramVenueId(venue)]}`,
    `${side}  ${s.symbol}  ·  ${s.timeframe}  ·  ${s.indicator}`,
    `ورود  ${fmtPx(s.entry)}`,
    `حد ضرر  ${fmtPx(s.sl)}`,
    `حد سود  ${fmtPx(s.tp)}`,
    `R:R  ${Number.isFinite(s.rr) ? s.rr.toFixed(2) : "—"}`,
    s.taken
      ? "وضعیت: گرفته شد"
      : s.queued
        ? "وضعیت: لیمیت در صف (FTC)"
        : `وضعیت: رد شد${s.skip ? ` · ${s.skip}` : ""}`,
  ];
  const why = s.reason.trim();
  if (why) lines.push(why);
  return lines.join("\n");
}

export function formatTelegramTest(venue: string) {
  return `تست تلگرام · ${VENUE_LABEL[telegramVenueId(venue)]}\nاگر این پیام را می‌بینی، سیگنال‌های این صرافی به همین چت می‌آیند.`;
}

export async function sendTelegramText(
  token: string,
  chatId: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; message: string }> {
  const cleanToken = token.trim();
  const cleanChat = chatId.trim();
  if (!isTelegramToken(cleanToken)) return { ok: false, message: "bot token is missing or invalid" };
  if (!isTelegramChatId(cleanChat)) return { ok: false, message: "chat id is missing or invalid" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${cleanToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: cleanChat,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
      }),
      signal: ctrl.signal,
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (res.ok && body?.ok) return { ok: true, message: "sent" };
    return { ok: false, message: body?.description || `telegram ${res.status}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : "telegram failed";
    return { ok: false, message };
  } finally {
    clearTimeout(timer);
  }
}
