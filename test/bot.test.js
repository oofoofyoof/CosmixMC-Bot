import test from "node:test";
import assert from "node:assert/strict";
import { parseDuration, parsePrefixCommand } from "../src/bot.js";
import {
  clearTicketConfig,
  getEffectiveTicketConfig,
  updateTicketConfig,
} from "../src/ticket-config.js";
import { parseGiveawayDuration, pickGiveawayWinners } from "../src/giveaway-store.js";
import { createHelpEmbed } from "../src/help.js";
import { slashCommands } from "../src/commands.js";
import {
  ensureApplication,
  ensureGuildApplications,
  getApplicationKey,
  normalizeApplicationName,
} from "../src/application-store.js";
import { getReactionKey, setReactionRole } from "../src/reaction-role-store.js";

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

test("help output lists registered slash commands and prefix-only commands", () => {
  const help = createHelpEmbed().toJSON();
  const slashField = help.fields.find(({ name }) => name === "Slash commands");
  assert.ok(slashCommands.some(({ name }) => name === "help"));
  for (const { name } of slashCommands) {
    assert.ok(slashField.value.includes(`/${name}`), `help should include /${name}`);
  }
  const prefixFields = help.fields.map(({ value }) => value).join("\n");
  for (const command of ["mute", "kick", "ban", "invites", "ticketconfig", "giveaway", "reactionroles", "applicationpost"]) {
    assert.ok(prefixFields.includes(command), `help should include ${command}`);
  }
});

test("reaction-role mappings persist emoji-to-role associations without overwriting", () => {
  const first = setReactionRole({}, "guild", "channel", "message", "🎉", "role-a");
  const second = setReactionRole(first, "guild", "channel", "message", "✨", "role-b");
  assert.deepEqual(second.guild.message.roles, { "🎉": "role-a", "✨": "role-b" });
  assert.equal(getReactionKey({ id: "emoji-id", name: "custom" }), "emoji-id");
  assert.throws(
    () => setReactionRole(second, "guild", "channel", "message", "🎉", "role-c"),
    /already has a role/,
  );
  assert.throws(
    () => setReactionRole(second, "guild", "another-channel", "message", "⭐", "role-c"),
    /different channel/,
  );
});

test("application setup normalizes names and keeps guild definitions separate", () => {
  assert.equal(normalizeApplicationName("  Helper   Team "), "helper team");
  assert.equal(getApplicationKey("Helper Team"), "helper-team");
  const first = ensureApplication({}, "guild-a", "helper-team", {
    name: "Helper Team",
    questions: ["Why?"],
    roleIds: [],
  });
  const second = ensureGuildApplications(first, "guild-b");
  assert.equal(second.guilds["guild-a"].applications["helper-team"].name, "Helper Team");
  assert.deepEqual(second.guilds["guild-b"].applications, {});
});

test("registers requested reaction-role and application slash command aliases", () => {
  const names = new Set(slashCommands.map((command) => command.name));
  for (const name of ["reactionroles", "rr", "reactionadd", "ra", "applyadd", "aa", "applicationrole", "ar", "applicationchannel", "ac", "applicationpost", "ap"]) {
    assert.ok(names.has(name), `missing /${name}`);
  }
  const reactionAdd = slashCommands.find((command) => command.name === "ra");
  assert.deepEqual(reactionAdd.options.map((option) => option.name), ["message-id", "emoji", "role"]);
  const applicationRole = slashCommands.find((command) => command.name === "ar");
  assert.deepEqual(applicationRole.options.map((option) => option.name), ["role", "application"]);
});
