import test from "node:test";
import assert from "node:assert/strict";
import { parseDuration, parsePrefixCommand } from "../src/bot.js";
import {
  clearTicketConfig,
  getEffectiveTicketConfig,
  updateTicketConfig,
} from "../src/ticket-config.js";
import { parseGiveawayDuration, pickGiveawayWinners } from "../src/giveaway-store.js";

test("parses supported timeout durations and enforces Discord's limit", () => {
  assert.equal(parseDuration("10m"), 10 * 60 * 1000);
  assert.equal(parseDuration("2h"), 2 * 60 * 60 * 1000);
  assert.equal(parseDuration("28d"), 28 * 24 * 60 * 60 * 1000);
  assert.equal(parseDuration("29d"), null);
  assert.equal(parseDuration("0m"), null);
  assert.equal(parseDuration("forever"), null);
});

test("parses each supported command prefix and ignores other messages", () => {
  assert.deepEqual(parsePrefixCommand(".ban @member spam"), {
    name: "ban",
    args: ["@member", "spam"],
  });
  assert.deepEqual(parsePrefixCommand("-ticketpost"), { name: "ticketpost", args: [] });
  assert.deepEqual(parsePrefixCommand("_invites"), { name: "invites", args: [] });
  assert.equal(parsePrefixCommand("!ban @member"), null);
});

test("ticket settings override environment defaults and can be cleared per guild", () => {
  const initial = {};
  const configured = updateTicketConfig(initial, "guild-a", {
    categoryId: "category-a",
    staffRoleId: "role-a",
  });
  assert.deepEqual(getEffectiveTicketConfig(configured, "guild-a", {
    TICKET_CATEGORY_ID: "default-category",
    TICKET_STAFF_ROLE_ID: "default-role",
  }), {
    categoryId: "category-a",
    staffRoleId: "role-a",
  });
  assert.deepEqual(getEffectiveTicketConfig(configured, "guild-b", {
    TICKET_CATEGORY_ID: "default-category",
    TICKET_STAFF_ROLE_ID: "default-role",
  }), {
    categoryId: "default-category",
    staffRoleId: "default-role",
  });

  const categoryCleared = clearTicketConfig(configured, "guild-a", "category");
  assert.deepEqual(getEffectiveTicketConfig(categoryCleared, "guild-a", {
    TICKET_CATEGORY_ID: "default-category",
    TICKET_STAFF_ROLE_ID: "default-role",
  }), {
    categoryId: "default-category",
    staffRoleId: "role-a",
  });
  assert.deepEqual(clearTicketConfig(categoryCleared, "guild-a", "all"), {});
});

test("validates giveaway durations and draws unique winners", () => {
  assert.equal(parseGiveawayDuration("1m"), 60_000);
  assert.equal(parseGiveawayDuration("2h"), 7_200_000);
  assert.equal(parseGiveawayDuration("30d"), 30 * 86_400_000);
  assert.equal(parseGiveawayDuration("30s"), null);
  assert.equal(parseGiveawayDuration("31d"), null);

  const winners = pickGiveawayWinners(["a", "b", "a", "c"], 2, () => 0);
  assert.equal(winners.length, 2);
  assert.equal(new Set(winners).size, 2);
  assert.ok(winners.every((winner) => ["a", "b", "c"].includes(winner)));
  assert.deepEqual(pickGiveawayWinners(["only-entry"], 3), ["only-entry"]);
});
