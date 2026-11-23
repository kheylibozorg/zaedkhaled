import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chatForVenue,
  formatSignalTelegram,
  isTelegramChatId,
  isTelegramToken,
  parseTelegramVenues,
  sendTelegramText,
  stringifyTelegramVenues,
  testChatFor,
} from "./telegram.ts";

describe("telegram signal routing", () => {
  it("keeps a venue off unless its option is on", () => {
    const prefs = parseTelegramVenues(
      JSON.stringify({
        aster: { on: true, chatId: "" },
        lighter: { on: false, chatId: "@lighter_sig" },
      }),
    );
    assert.equal(chatForVenue(prefs, "aster", "-1001234567890"), "-1001234567890");
    assert.equal(chatForVenue(prefs, "lighter", "-1001234567890"), null);
    assert.equal(chatForVenue(prefs, "ourbit", "-1001234567890"), null);
    assert.equal(chatForVenue(prefs, "paper", ""), null);
  });

  it("prefers the venue chat over the shared channel", () => {
    const prefs = parseTelegramVenues('{"hyperliquid":{"on":true,"chatId":"@hl_desk"}}');
    assert.equal(chatForVenue(prefs, "hyperliquid", "-1001234567890"), "@hl_desk");
    assert.equal(testChatFor(prefs, "ourbit", "@shared"), "@shared");
  });

  it("rejects a blank or malformed chat instead of posting nowhere useful", () => {
    const prefs = parseTelegramVenues('{"aster":{"on":true,"chatId":"not a chat"}}');
    assert.equal(chatForVenue(prefs, "aster", "also bad"), null);
    assert.equal(isTelegramChatId("@ok_channel"), true);
    assert.equal(isTelegramChatId("-1001234567890"), true);
    assert.equal(isTelegramToken("123456:AA-good_token_value_here_ok"), true);
    assert.equal(isTelegramToken("nope"), false);
  });

  it("round-trips only known venues", () => {
    const raw = stringifyTelegramVenues({
      aster: { on: true, chatId: "@aster" },
      extra: { on: true, chatId: "@nope" },
    } as never);
    const prefs = parseTelegramVenues(raw);
    assert.equal(prefs.aster.on, true);
    assert.equal(prefs.aster.chatId, "@aster");
    assert.equal(prefs.ourbit.on, false);
    assert.equal("extra" in JSON.parse(raw), false);
  });

  it("formats a signal without touching prices into science notation", () => {
    const text = formatSignalTelegram("aster", {
      symbol: "BTCUSDT",
      timeframe: "15m",
      indicator: "APEX1",
      side: "long",
      entry: 64210.5,
      sl: 63880,
      tp: 65100.25,
      rr: 1.8,
      reason: "second test",
      taken: false,
      skip: "already filled",
    });
    assert.match(text, /Aster/);
    assert.match(text, /لانگ/);
    assert.match(text, /64210\.5/);
    assert.match(text, /already filled/);
    assert.doesNotMatch(text, /e\+/i);

    const queuedText = formatSignalTelegram("paper", {
      symbol: "ETHUSDT",
      timeframe: "15m",
      indicator: "KETEX",
      side: "short",
      entry: 3200,
      sl: 3240,
      tp: 3120,
      rr: 2,
      reason: "armed FTC limit",
      taken: false,
      queued: true,
      skip: "",
    });
    assert.match(queuedText, /لیمیت در صف/);
  });

  it("posts via the bot API and surfaces Telegram's error", async () => {
    const calls: string[] = [];
    const ok = await sendTelegramText("123456789:AA-good_token_value_here_ok", "-1001234567890", "سلام", async (url, init) => {
      calls.push(String(url));
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.chat_id, "-1001234567890");
      assert.equal(body.text, "سلام");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    assert.equal(ok.ok, true);
    assert.match(calls[0]!, /api\.telegram\.org\/bot123456789:AA-good_token_value_here_ok\/sendMessage/);

    const bad = await sendTelegramText("123456789:AA-good_token_value_here_ok", "@channel", "x", async () => {
      return new Response(JSON.stringify({ ok: false, description: "Forbidden: bot is not a member of the channel" }), {
        status: 403,
      });
    });
    assert.equal(bad.ok, false);
    assert.match(bad.message, /not a member/);
  });
});
