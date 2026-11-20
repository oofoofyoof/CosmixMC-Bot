import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  clearTicketConfig,
  getEffectiveTicketConfig,
  loadTicketConfigs,
  saveTicketConfigs,
  updateTicketConfig,
} from "./ticket-config.js";
import {
  loadGiveaways,
  parseGiveawayDuration,
  pickGiveawayWinners,
  saveGiveaways,
} from "./giveaway-store.js";
import {
  getReactionKey,
  loadReactionRoles,
  saveReactionRoles,
  setReactionRole,
} from "./reaction-role-store.js";
import {
  ensureApplication,
  ensureGuildApplications,
  getApplicationKey,
  loadApplications,
  normalizeApplicationName,
  saveApplications,
} from "./application-store.js";

const PREFIXES = [".", "-", "_"];
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
const DATA_FILE = path.resolve("data/invites.json");
const TICKET_BUTTON_ID = "cosmixmc:ticket-open";
const TICKET_MODAL_ID = "cosmixmc:ticket-issue";
const TICKET_CLOSE_ID = "cosmixmc:ticket-close";
const GIVEAWAY_BUTTON_ID = "cosmixmc:giveaway-enter";
const APPLICATION_PANEL_PREFIX = "cosmixmc:application:";
const APPLICATION_REVIEW_PREFIX = "cosmixmc:application-review:";
const MAX_GIVEAWAY_TIMER_MS = 2_147_483_647;
const MAX_APPLICATION_QUESTIONS = 10;

export function parseDuration(value) {
  const match = /^(\d+)(s|m|h|d|w)$/i.exec(value ?? "");
  if (!match) return null;

  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const duration = Number(match[1]) * multipliers[match[2].toLowerCase()];
  return Number.isSafeInteger(duration) && duration > 0 && duration <= MAX_TIMEOUT_MS
    ? duration
    : null;
}

export function parsePrefixCommand(content) {
  const prefix = PREFIXES.find((candidate) => content.startsWith(candidate));
  if (!prefix) return null;
  const [name, ...args] = content.slice(prefix.length).trim().split(/\s+/);
  return name ? { name: name.toLowerCase(), args } : null;
}

async function loadInviteData() {
  try {
    const data = JSON.parse(await readFile(DATA_FILE, "utf8"));
    return {
      totals: data.totals ?? {},
      members: data.members ?? {},
    };
  } catch (error) {
    if (error.code === "ENOENT") return { totals: {}, members: {} };
    throw new Error(`Could not read invite data at ${DATA_FILE}: ${error.message}`, { cause: error });
  }
}

async function saveInviteData(data) {
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function getInviterKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function makeTicketPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("CosmixMC Support")
    .setDescription("Click the button below to open a private support ticket. You’ll be asked to describe your issue.");
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_BUTTON_ID)
      .setLabel("Create ticket")
      .setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

function makeTicketModal() {
  const issue = new TextInputBuilder()
    .setCustomId("issue")
    .setLabel("What do you need help with?")
    .setPlaceholder("Describe your issue so our team can help.")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000);
  return new ModalBuilder()
    .setCustomId(TICKET_MODAL_ID)
    .setTitle("Open a support ticket")
    .addComponents(new ActionRowBuilder().addComponents(issue));
}

function ticketStaffOverwrites(guild, settings) {
  if (settings.staffRoleId) {
    const role = guild.roles.cache.get(settings.staffRoleId);
    if (!role || role.id === guild.id) {
      throw new Error("The configured ticket staff role is missing or invalid.");
    }
    return [{
      id: role.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    }];
  }

  const staffRoles = guild.roles.cache.filter((role) =>
    role.id !== guild.id && (
      role.permissions.has(PermissionFlagsBits.Administrator) ||
      role.permissions.has(PermissionFlagsBits.ManageChannels)
    ),
  );
  if (staffRoles.size > 95) {
    throw new Error("Too many staff roles to create a ticket channel safely; set TICKET_STAFF_ROLE_ID.");
  }
  return [...staffRoles.values()].map((role) => ({
    id: role.id,
    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
  }));
}

async function createTicket(interaction, ticketConfigs) {
  const guild = interaction.guild;
  const opener = interaction.user;
  const issue = interaction.fields.getTextInputValue("issue").trim();

  const existing = guild.channels.cache.find((channel) =>
    channel.type === ChannelType.GuildText && channel.topic === `ticket-owner:${opener.id}`,
  );
  if (existing) {
    await interaction.reply({ content: `You already have an open ticket: ${existing}`, ephemeral: true });
    return;
  }

  const settings = getEffectiveTicketConfig(ticketConfigs, guild.id);
  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: opener.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
    {
      id: interaction.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
    },
    ...ticketStaffOverwrites(guild, settings),
  ];

  let parent;
  if (settings.categoryId) {
    parent = guild.channels.cache.get(settings.categoryId);
    if (!parent || parent.type !== ChannelType.GuildCategory) {
      throw new Error("The configured ticket category is missing or invalid.");
    }
  }

  const channel = await guild.channels.create({
    name: `ticket-${opener.username.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 80)}`,
    type: ChannelType.GuildText,
    topic: `ticket-owner:${opener.id}`,
    parent,
    permissionOverwrites: overwrites,
    reason: `Support ticket opened by ${opener.tag}`,
  });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("New support ticket")
    .setDescription(issue)
    .addFields({ name: "Opened by", value: `${opener}`, inline: true })
    .setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_CLOSE_ID)
      .setLabel("Close ticket")
      .setStyle(ButtonStyle.Danger),
  );
  await channel.send({
    content: `${opener} opened a ticket. Staff can help here.`,
    embeds: [embed],
    components: [row],
    allowedMentions: { users: [opener.id] },
  });
  await interaction.reply({ content: `Your ticket is open: ${channel}`, ephemeral: true });
}

async function resolveMember(message, token) {
  const mentioned = message.mentions.members.first();
  if (mentioned && (!token || token.includes(mentioned.id))) return mentioned;
  const id = token?.replace(/[<@!>]/g, "");
  if (!id || !/^\d{17,20}$/.test(id)) return null;
  return message.guild.members.fetch(id).catch(() => null);
}

function hasPermission(member, permission) {
  return member.permissions.has(permission);
}

async function runModerationCommand(message, command) {
  const { member } = message;
  const commandName = command.name;
  const permission = commandName === "ban"
    ? PermissionFlagsBits.BanMembers
    : commandName === "kick"
      ? PermissionFlagsBits.KickMembers
      : PermissionFlagsBits.ModerateMembers;

  if (!hasPermission(member, permission)) {
    await message.reply("You don’t have permission to use that command.");
    return;
  }

  const target = await resolveMember(message, command.args[0]);
  if (!target) {
    await message.reply(`Usage: \`${PREFIXES[0]}${commandName} @member${commandName === "mute" ? " 10m" : ""} [reason]\``);
    return;
  }
  if (target.id === message.author.id) {
    await message.reply("You can’t use this command on yourself.");
    return;
  }
  if (
    !member.permissions.has(PermissionFlagsBits.Administrator) &&
    target.roles.highest.comparePositionTo(member.roles.highest) >= 0
  ) {
    await message.reply("You can’t moderate a member with an equal or higher role.");
    return;
  }

  const reasonStart = commandName === "mute" ? 2 : 1;
  const reason = command.args.slice(reasonStart).join(" ") || `Action by ${message.author.tag}`;
  if (!target.moderatable && commandName === "mute") {
    await message.reply("I can’t time out that member. Check my role position and permissions.");
    return;
  }
  if (commandName === "kick" && !target.kickable) {
    await message.reply("I can’t kick that member. Check my role position and permissions.");
    return;
  }
  if (commandName === "ban" && !target.bannable) {
    await message.reply("I can’t ban that member. Check my role position and permissions.");
    return;
  }

  if (commandName === "mute") {
    const duration = parseDuration(command.args[1]);
    if (!duration) {
      await message.reply("Provide a duration from `1s` to `28d`, for example `10m` or `2h`.");
      return;
    }
    await target.timeout(duration, reason);
    await message.reply(`Timed out ${target} for ${command.args[1]}. Reason: ${reason}`);
  } else if (commandName === "kick") {
    await target.kick(reason);
    await message.reply(`Kicked ${target.user.tag}. Reason: ${reason}`);
  } else {
    await target.ban({ reason });
    await message.reply(`Banned ${target.user.tag}. Reason: ${reason}`);
  }
}

async function postTicketPanel(message) {
  if (!hasPermission(message.member, PermissionFlagsBits.ManageChannels)) {
    await message.reply("You need the Manage Channels permission to post a ticket panel.");
    return;
  }
  await message.channel.send(makeTicketPanel());
  await message.reply("Ticket panel posted.");
}

function ticketConfigSummary(guild, configs) {
  const settings = getEffectiveTicketConfig(configs, guild.id);
  const category = settings.categoryId
    ? guild.channels.cache.get(settings.categoryId)
    : null;
  const staffRole = settings.staffRoleId
    ? guild.roles.cache.get(settings.staffRoleId)
    : null;
  const categoryText = category?.type === ChannelType.GuildCategory
    ? `${category}`
    : settings.categoryId
      ? `not found (<#${settings.categoryId}>)`
      : "not set";
  const staffRoleText = staffRole
    ? `${staffRole}`
    : settings.staffRoleId
      ? `not found (<@&${settings.staffRoleId}>)`
      : "automatic (Manage Channels/Admin roles)";
  return `Ticket category: ${categoryText}\nTicket staff role: ${staffRoleText}`;
}

async function saveGuildTicketConfig(current, guildId, patch) {
  const updated = updateTicketConfig(current, guildId, patch);
  await saveTicketConfigs(updated);
  return updated;
}

function extractReferenceId(value, mentionPattern) {
  const mention = mentionPattern.exec(value ?? "");
  if (mention) return mention[1];
  return /^\d{17,20}$/.test(value ?? "") ? value : null;
}

async function handlePrefixTicketConfig(message, args, ticketConfigs) {
  if (!hasPermission(message.member, PermissionFlagsBits.ManageChannels)) {
    await message.reply("You need the Manage Channels permission to configure ticket settings.");
    return ticketConfigs;
  }

  const setting = args[0]?.toLowerCase();
  if (!setting || setting === "show") {
    await message.reply(ticketConfigSummary(message.guild, ticketConfigs));
    return ticketConfigs;
  }
  if (setting === "clear") {
    const clearSetting = args[1]?.toLowerCase();
    if (!["category", "staff-role", "staffrole", "all"].includes(clearSetting)) {
      await message.reply("Usage: `ticketconfig clear category|staffrole|all`");
      return ticketConfigs;
    }
    const normalized = clearSetting === "staffrole" ? "staff-role" : clearSetting;
    const updated = clearTicketConfig(ticketConfigs, message.guild.id, normalized);
    await saveTicketConfigs(updated);
    await message.reply(`Cleared ticket ${normalized === "all" ? "settings" : normalized + " setting"}.\n${ticketConfigSummary(message.guild, updated)}`);
    return updated;
  }

  const value = args[1];
  if (setting === "category") {
    const id = extractReferenceId(value, /^<#(\d+)>$/);
    const category = id ? message.guild.channels.cache.get(id) : null;
    if (!category || category.type !== ChannelType.GuildCategory) {
      await message.reply("Choose a category channel, for example `ticketconfig category #support-tickets`.");
      return ticketConfigs;
    }
    const updated = await saveGuildTicketConfig(ticketConfigs, message.guild.id, { categoryId: category.id });
    await message.reply(`Ticket category set to ${category}.\n${ticketConfigSummary(message.guild, updated)}`);
    return updated;
  }

  if (["staff-role", "staffrole"].includes(setting)) {
    const id = extractReferenceId(value, /^<@&(\d+)>$/);
    const role = id ? message.guild.roles.cache.get(id) : null;
    if (!role || role.id === message.guild.id) {
      await message.reply("Choose a server role, for example `ticketconfig staffrole @Support`.");
      return ticketConfigs;
    }
    const updated = await saveGuildTicketConfig(ticketConfigs, message.guild.id, { staffRoleId: role.id });
    await message.reply(`Ticket staff role set to ${role}.\n${ticketConfigSummary(message.guild, updated)}`);
    return updated;
  }

  await message.reply("Usage: `ticketconfig [show|category #category|staffrole @role|clear category|staffrole|all]`");
  return ticketConfigs;
}

function makeGiveawayComponents(disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(GIVEAWAY_BUTTON_ID)
        .setLabel("Enter giveaway")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
    ),
  ];
}

function makeGiveawayEmbed(giveaway, winnerIds = null) {
  const ended = winnerIds !== null;
  const outcome = ended
    ? winnerIds.length
      ? `Winner${winnerIds.length === 1 ? "" : "s"}: ${winnerIds.map((id) => `<@${id}>`).join(", ")}`
      : "No one entered this giveaway."
    : `Ends <t:${Math.floor(giveaway.endsAt / 1000)}:R>`;
  return new EmbedBuilder()
    .setColor(ended ? 0x747f8d : 0x5865f2)
    .setTitle(ended ? "Giveaway ended" : "🎉 Giveaway")
    .setDescription(`**Prize:** ${giveaway.prize}\n**Hosted by:** <@${giveaway.hostId}>\n**Winners:** ${giveaway.winnerCount}\n\n${outcome}`)
    .setTimestamp(ended ? new Date(giveaway.endsAt) : new Date());
}

async function startGiveaway({ channel, host, prize, duration, winnerCount, giveaways, giveawayTimers, client }) {
  const endsAt = Date.now() + duration;
  const giveaway = {
    guildId: channel.guild.id,
    channelId: channel.id,
    prize,
    hostId: host.id,
    winnerCount,
    entrantIds: [],
    endsAt,
    status: "active",
  };
  const message = await channel.send({
    embeds: [makeGiveawayEmbed(giveaway)],
    components: makeGiveawayComponents(),
    allowedMentions: { parse: [] },
  });
  giveaway.messageId = message.id;
  giveaways[message.id] = giveaway;
  try {
    await saveGiveaways(giveaways);
  } catch (error) {
    delete giveaways[message.id];
    await message.delete().catch((deleteError) => {
      console.error(`Could not remove untracked giveaway message ${message.id}: ${deleteError.message}`);
    });
    throw error;
  }
  scheduleGiveawayEnd(client, giveaways, giveawayTimers, message.id);
  return message;
}

function scheduleGiveawayEnd(client, giveaways, giveawayTimers, messageId, delayOverride) {
  const existingTimer = giveawayTimers.get(messageId);
  if (existingTimer) clearTimeout(existingTimer);
  const giveaway = giveaways[messageId];
  if (!giveaway || giveaway.status !== "active") {
    giveawayTimers.delete(messageId);
    return;
  }

  const remaining = Math.max(0, giveaway.endsAt - Date.now());
  const delay = Math.min(delayOverride ?? remaining, MAX_GIVEAWAY_TIMER_MS);
  const timer = setTimeout(() => {
    if (giveaway.endsAt > Date.now()) {
      scheduleGiveawayEnd(client, giveaways, giveawayTimers, messageId);
      return;
    }
    endGiveaway(client, giveaways, giveawayTimers, messageId).catch((error) => {
      console.error(`Could not end giveaway ${messageId}: ${error.message}`);
    });
  }, delay);
  giveawayTimers.set(messageId, timer);
}

async function endGiveaway(client, giveaways, giveawayTimers, messageId) {
  const giveaway = giveaways[messageId];
  if (!giveaway || giveaway.status !== "active") return;
  giveaway.status = "ending";
  giveawayTimers.delete(messageId);
  try {
    await saveGiveaways(giveaways);
    const channel = await client.channels.fetch(giveaway.channelId);
    if (!channel?.isTextBased()) throw new Error("Giveaway channel is unavailable or not a text channel.");
    const message = await channel.messages.fetch(messageId);
    const winners = pickGiveawayWinners(giveaway.entrantIds, giveaway.winnerCount);
    await message.edit({
      embeds: [makeGiveawayEmbed(giveaway, winners)],
      components: makeGiveawayComponents(true),
      allowedMentions: { parse: [] },
    });
    if (winners.length) {
      await channel.send({
        content: `Congratulations ${winners.map((id) => `<@${id}>`).join(", ")}! You won **${giveaway.prize}**.`,
        allowedMentions: { users: winners },
      });
    } else {
      await channel.send(`The giveaway for **${giveaway.prize}** ended with no entries.`);
    }
    giveaway.winnerIds = winners;
    giveaway.status = "ended";
    await saveGiveaways(giveaways);
  } catch (error) {
    giveaway.status = "active";
    try {
      await saveGiveaways(giveaways);
    } catch (saveError) {
      console.error(`Could not save giveaway retry state ${messageId}: ${saveError.message}`);
    }
    scheduleGiveawayEnd(client, giveaways, giveawayTimers, messageId, 60_000);
    throw error;
  }
}

async function enterGiveaway(interaction, giveaways) {
  const giveaway = giveaways[interaction.message.id];
  if (!giveaway || giveaway.status !== "active") {
    await interaction.reply({ content: "This giveaway is no longer open.", ephemeral: true });
    return;
  }
  if (giveaway.endsAt <= Date.now()) {
    await interaction.reply({ content: "This giveaway has ended.", ephemeral: true });
    return;
  }
  if (giveaway.entrantIds.includes(interaction.user.id)) {
    await interaction.reply({ content: "You’re already entered in this giveaway.", ephemeral: true });
    return;
  }
  giveaway.entrantIds.push(interaction.user.id);
  try {
    await saveGiveaways(giveaways);
  } catch (error) {
    giveaway.entrantIds.pop();
    throw error;
  }
  await interaction.reply({ content: `You’re entered for **${giveaway.prize}**!`, ephemeral: true });
}

async function handlePrefixGiveaway(message, args, giveaways, giveawayTimers, client) {
  if (!hasPermission(message.member, PermissionFlagsBits.ManageGuild)) {
    await message.reply("You need the Manage Server permission to start a giveaway.");
    return;
  }
  const duration = parseGiveawayDuration(args[0]);
  const hasWinnerCount = /^\d+$/.test(args[1] ?? "");
  const winnerCount = hasWinnerCount ? Number(args[1]) : 1;
  const prize = args.slice(hasWinnerCount ? 2 : 1).join(" ").trim();
  if (!duration || winnerCount < 1 || winnerCount > 20 || !prize || prize.length > 256) {
    await message.reply("Usage: `giveaway <duration> [winner-count] <prize>` (for example `giveaway 2h 1 Minecraft rank`). Duration: 1m–30d; winners: 1–20.");
    return;
  }
  const giveawayMessage = await startGiveaway({
    channel: message.channel,
    host: message.author,
    prize,
    duration,
    winnerCount,
    giveaways,
    giveawayTimers,
    client,
  });
  await message.reply(`Giveaway started: ${giveawayMessage}`);
}

function parseRoleMention(message, token) {
  const mentioned = message.mentions.roles.first();
  if (mentioned && (!token || token.includes(mentioned.id))) return mentioned;
  const id = token?.replace(/[<@&>]/g, "");
  return id ? message.guild.roles.cache.get(id) ?? null : null;
}

function parseCustomEmoji(guild, value) {
  const match = /^<a?:[a-zA-Z0-9_]+:(\d+)>$/.exec(value ?? "");
  if (!match) return { reaction: value, key: value };
  const emoji = guild.emojis.cache.get(match[1]);
  return emoji ? { reaction: emoji.toString(), key: emoji.id } : null;
}

function assertRoleManageable(guild, actor, role, selfAssignable = false) {
  if (!role || role.id === guild.id || role.managed || role.permissions.has(PermissionFlagsBits.Administrator)) {
    throw new Error("Choose a regular, non-managed role without Administrator permission.");
  }
  const selfAssignablePermissions = [
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ManageWebhooks,
    PermissionFlagsBits.ManageEvents,
    PermissionFlagsBits.ManageThreads,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.MentionEveryone,
    PermissionFlagsBits.ViewAuditLog,
  ];
  if (selfAssignable && selfAssignablePermissions.some((permission) => role.permissions.has(permission))) {
    throw new Error("Reaction roles can’t grant server-management or moderation permissions.");
  }
  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= botMember.roles.highest.position) {
    throw new Error("The bot needs Manage Roles, and its highest role must be above the selected role.");
  }
  if (
    !actor.permissions.has(PermissionFlagsBits.Administrator) &&
    (!actor.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= actor.roles.highest.position)
  ) {
    throw new Error("You need Manage Roles and a higher role than the role you selected.");
  }
}

async function addReactionRoleToMessage({ guild, channel, message, role, emojiText, actor, reactionRoles }) {
  assertRoleManageable(guild, actor, role, true);
  const emoji = parseCustomEmoji(guild, emojiText);
  if (!emoji?.reaction) throw new Error("Enter a valid Unicode emoji or a custom emoji from this server.");
  const current = reactionRoles[guild.id]?.[message.id]?.roles ?? {};
  const updated = setReactionRole(reactionRoles, guild.id, channel.id, message.id, emoji.key, role.id);
  if (current[emoji.key]) throw new Error("That emoji already has a role on this message.");
  await message.react(emoji.reaction);
  try {
    await saveReactionRoles(updated);
  } catch (error) {
    await message.reactions.resolve(emoji.reaction)?.remove().catch((removeError) => {
      console.error(`Could not remove untracked reaction from ${message.id}: ${removeError.message}`);
    });
    throw error;
  }
  for (const [guildId, entries] of Object.entries(updated)) {
    reactionRoles[guildId] = entries;
  }
  for (const guildId of Object.keys(reactionRoles)) {
    if (!updated[guildId]) delete reactionRoles[guildId];
  }
}

async function createReactionRoleMessage({ guild, channel, actor, role, text, emojiText, reactionRoles }) {
  if (!text.trim()) throw new Error("Provide the text for the reaction-role message.");
  const message = await channel.send(text);
  try {
    await addReactionRoleToMessage({
      guild,
      channel,
      message,
      role,
      emojiText,
      actor,
      reactionRoles,
    });
  } catch (error) {
    await message.delete().catch((deleteError) => {
      console.error(`Could not remove incomplete reaction-role message ${message.id}: ${deleteError.message}`);
    });
    throw error;
  }
  return message;
}

async function findMessageInChannel(channel, messageId) {
  if (!/^\d{17,20}$/.test(messageId ?? "")) return null;
  return channel.messages.fetch(messageId).catch(() => null);
}

function findGuildApplication(applications, guildId, name) {
  if (!name?.trim()) return null;
  const guildConfig = applications.guilds[guildId];
  const key = getApplicationKey(name);
  const application = guildConfig?.applications?.[key];
  return application && normalizeApplicationName(application.name) === normalizeApplicationName(name)
    ? { key, application }
    : null;
}

function makeApplicationPanel(application, key) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${application.name} Application`)
    .setDescription("Click below to apply. The bot will send you the application questions in a private DM.");
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${APPLICATION_PANEL_PREFIX}${key}`)
      .setLabel("Apply")
      .setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

function makeApplicationReviewButtons(messageId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${APPLICATION_REVIEW_PREFIX}accept:${messageId}`)
        .setLabel("Accept")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${APPLICATION_REVIEW_PREFIX}deny:${messageId}`)
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function makeApplicationReviewEmbed(application, applicant, questions, answers, status = "Pending review") {
  const embed = new EmbedBuilder()
    .setColor(status === "Pending review" ? 0x5865f2 : status === "Accepted" ? 0x57f287 : 0xed4245)
    .setTitle(`${application.name} application`)
    .setDescription(`Applicant: <@${applicant.id}> (\`${applicant.id}\`)\nStatus: **${status}**`)
    .setTimestamp();
  for (let index = 0; index < questions.length; index += 1) {
    embed.addFields({
      name: questions[index].slice(0, 256),
      value: (answers[index] || "(No answer)").slice(0, 1024),
    });
  }
  return embed;
}

async function startApplicationBuilder(user, guildId, name, applications, pendingBuilders) {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("Provide an application name, for example `aa Helper`.");
  }
  const key = getApplicationKey(name);
  if (!key) throw new Error("Give the application a name containing letters or numbers.");
  if (name.length > 80) throw new Error("Application names can’t be longer than 80 characters.");
  if (applications.guilds[guildId]?.applications?.[key]) {
    throw new Error(`An application named “${applications.guilds[guildId].applications[key].name}” already exists.`);
  }
  if (pendingBuilders.has(user.id)) throw new Error("Finish your current application setup in DMs before starting another.");

  const dm = await user.createDM();
  pendingBuilders.set(user.id, { guildId, name: name.trim(), key, stage: "count", questions: [] });
  try {
    await dm.send(`Let’s set up the **${name.trim()}** application. How many questions should it have? Reply with a number from 1 to ${MAX_APPLICATION_QUESTIONS}.`);
  } catch (error) {
    pendingBuilders.delete(user.id);
    throw new Error(`I couldn’t DM you. Enable direct messages from server members and try again: ${error.message}`, { cause: error });
  }
}

async function postApplicationSubmission(client, applications, interview, applicant) {
  const guildConfig = applications.guilds[interview.guildId];
  const reviewChannel = guildConfig?.reviewChannelId
    ? await client.channels.fetch(guildConfig.reviewChannelId)
    : null;
  if (!reviewChannel?.isTextBased() || reviewChannel.guildId !== interview.guildId) {
    throw new Error("The application review channel is not configured or is unavailable. Please contact a server administrator.");
  }
  const application = guildConfig.applications[interview.applicationKey];
  if (!application) throw new Error("This application is no longer available.");

  const embeds = [];
  for (let index = 0; index < interview.questions.length; index += 3) {
    embeds.push(makeApplicationReviewEmbed(
      application,
      applicant,
      interview.questions.slice(index, index + 3),
      interview.answers.slice(index, index + 3),
    ));
  }

  const postedMessages = [];
  let savedSubmissionId;
  try {
    for (let index = 0; index < embeds.length; index += 1) {
      const message = await reviewChannel.send({
        embeds: [embeds[index]],
        allowedMentions: { parse: [] },
      });
      postedMessages.push(message);
      if (index === embeds.length - 1) {
        const submission = {
          guildId: interview.guildId,
          applicationKey: interview.applicationKey,
          applicantId: applicant.id,
          status: "pending",
          messageIds: postedMessages.map((posted) => posted.id),
          reviewMessageId: message.id,
          reviewChannelId: reviewChannel.id,
          answers: interview.answers,
        };
        applications.submissions[message.id] = submission;
        try {
          await saveApplications(applications);
          savedSubmissionId = message.id;
          await message.edit({ components: makeApplicationReviewButtons(message.id) });
        } catch (error) {
          delete applications.submissions[message.id];
          throw error;
        }
      }
    }
  } catch (error) {
    if (savedSubmissionId) {
      delete applications.submissions[savedSubmissionId];
      await saveApplications(applications).catch((saveError) => {
        console.error(`Could not remove incomplete application submission ${savedSubmissionId}: ${saveError.message}`);
      });
    }
    for (const message of postedMessages) {
      await message.delete().catch((deleteError) => {
        console.error(`Could not remove incomplete application review ${message.id}: ${deleteError.message}`);
      });
    }
    throw error;
  }
}

async function beginApplicationInterview(interaction, applications, interviews) {
  const application = applications.guilds[interaction.guildId]?.applications?.[interaction.customId.slice(APPLICATION_PANEL_PREFIX.length)];
  if (!application) {
    await interaction.reply({ content: "This application is no longer available.", ephemeral: true });
    return;
  }
  if (interviews.has(interaction.user.id)) {
    await interaction.reply({ content: "You already have an application in progress. Finish it in DMs first.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const dm = await interaction.user.createDM();
    interviews.set(interaction.user.id, {
      guildId: interaction.guildId,
      applicationKey: interaction.customId.slice(APPLICATION_PANEL_PREFIX.length),
      questions: application.questions,
      answers: [],
    });
    await dm.send(`You’re applying for **${application.name}**. Please answer the questions below. You can type \`cancel\` any time to stop.\n\n**Question 1/${application.questions.length}:** ${application.questions[0]}`);
  } catch (error) {
    interviews.delete(interaction.user.id);
    await interaction.editReply("I couldn’t DM you. Enable direct messages from server members and try again.");
    console.error(`Could not start application DM for ${interaction.user.id}: ${error.message}`);
    return;
  }
  await interaction.editReply("I sent you a DM to start your application.");
}

async function handleApplicationDm(message, applications, pendingBuilders, interviews) {
  const builder = pendingBuilders.get(message.author.id);
  if (builder) {
    const response = message.content.trim();
    if (builder.stage === "count") {
      const count = Number(response);
      if (!Number.isInteger(count) || count < 1 || count > MAX_APPLICATION_QUESTIONS) {
        await message.reply(`Please reply with a whole number from 1 to ${MAX_APPLICATION_QUESTIONS}.`);
        return;
      }
      builder.questionCount = count;
      builder.stage = "questions";
      await message.reply(`What should question 1/${count} ask? Keep it under 500 characters.`);
      return;
    }

    if (!response || response.length > 500) {
      await message.reply("Please send a question between 1 and 500 characters.");
      return;
    }
    builder.questions.push(response);
    if (builder.questions.length < builder.questionCount) {
      await message.reply(`What should question ${builder.questions.length + 1}/${builder.questionCount} ask?`);
      return;
    }

    const updated = ensureApplication(applications, builder.guildId, builder.key, {
      name: builder.name,
      questions: builder.questions,
      roleIds: [],
    });
    try {
      await saveApplications(updated);
    } catch (error) {
      builder.questions.pop();
      throw error;
    }
    for (const key of Object.keys(applications)) delete applications[key];
    Object.assign(applications, updated);
    pendingBuilders.delete(message.author.id);
    await message.reply(`The **${builder.name}** application is ready. Set its review channel with \`/applicationchannel\`, optionally add acceptance roles with \`/applicationrole\`, then post its panel with \`/applicationpost\`.`);
    return;
  }

  const interview = interviews.get(message.author.id);
  if (!interview) return;
  const response = message.content.trim();
  if (response.toLowerCase() === "cancel") {
    interviews.delete(message.author.id);
    await message.reply("Your application was cancelled.");
    return;
  }
  if (!response || response.length > 1000) {
    await message.reply("Please send an answer between 1 and 1000 characters.");
    return;
  }
  interview.answers.push(response);
  const nextIndex = interview.answers.length;
  if (nextIndex < interview.questions.length) {
    await message.reply(`**Question ${nextIndex + 1}/${interview.questions.length}:** ${interview.questions[nextIndex]}`);
    return;
  }

  try {
    await postApplicationSubmission(message.client, applications, interview, message.author);
    interviews.delete(message.author.id);
    await message.reply("Your application has been submitted for review. Thank you!");
  } catch (error) {
    interview.answers.pop();
    throw error;
  }
}

async function startApplicationCommand(user, guildId, name, applications, pendingBuilders) {
  await startApplicationBuilder(user, guildId, name, applications, pendingBuilders);
}

async function handlePrefixReactionCommand(message, command, reactionRoles) {
  if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await message.reply("You need Manage Roles to configure reaction roles.");
    return;
  }

  if (["rr", "reactionroles"].includes(command.name)) {
    const role = parseRoleMention(message, command.args[0]);
    const emoji = command.args.at(-1);
    const text = command.args.slice(1, -1).join(" ");
    const created = await createReactionRoleMessage({
      guild: message.guild,
      channel: message.channel,
      actor: message.member,
      role,
      text,
      emojiText: emoji,
      reactionRoles,
    });
    await message.reply(`Reaction-role message created: ${created}`);
    return;
  }

  const messageId = command.args[0];
  const emoji = command.args[1];
  const role = parseRoleMention(message, command.args[2]);
  const targetMessage = await findMessageInChannel(message.channel, messageId);
  if (!targetMessage) throw new Error("I couldn’t find that message in this channel.");
  await addReactionRoleToMessage({
    guild: message.guild,
    channel: message.channel,
    message: targetMessage,
    role,
    emojiText: emoji,
    actor: message.member,
    reactionRoles,
  });
  await message.reply(`Added ${emoji} → ${role} to message \`${messageId}\`.`);
}

async function handlePrefixApplicationCommand(message, command, context) {
  const { applications, pendingBuilders } = context;
  const args = command.args;
  const commandName = command.name;
  if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await message.reply("You need Manage Server to configure applications.");
    return;
  }

  if (["aa", "applyadd"].includes(commandName)) {
    await startApplicationCommand(message.author, message.guild.id, args.join(" "), applications, pendingBuilders);
    await message.reply("I’ve DM’d you to build the application. Answer the questions there.");
    return;
  }
  if (["ar", "applicationrole"].includes(commandName)) {
    if (args.length < 2) throw new Error("Usage: `ar @Role application name`.");
    const role = parseRoleMention(message, args[0]);
    const name = args.slice(1).join(" ");
    const found = findGuildApplication(applications, message.guild.id, name);
    if (!found) throw new Error("I couldn’t find that application. Check its name or create it with `aa` first.");
    assertRoleManageable(message.guild, message.member, role);
    const updated = ensureApplication(applications, message.guild.id, found.key, {
      ...found.application,
      roleIds: [...new Set([...found.application.roleIds, role.id])],
    });
    await saveApplications(updated);
    Object.assign(applications, updated);
    await message.reply(`Added ${role} as an acceptance role for **${found.application.name}**.`);
    return;
  }
  if (["ac", "applicationchannel"].includes(commandName)) {
    const channelId = args[0]?.replace(/[<#>]/g, "");
    const channel = message.guild.channels.cache.get(channelId);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
      throw new Error("Choose a text channel, for example `ac #applications`.");
    }
    const updated = ensureGuildApplications(applications, message.guild.id);
    updated.guilds[message.guild.id].reviewChannelId = channel.id;
    await saveApplications(updated);
    Object.assign(applications, updated);
    await message.reply(`Application reviews will be sent to ${channel}.`);
    return;
  }
  if (["ap", "applicationpost"].includes(commandName)) {
    if (!args.length) throw new Error("Usage: `ap application name`.");
    const found = findGuildApplication(applications, message.guild.id, args.join(" "));
    if (!found) throw new Error("I couldn’t find that application. Check its name or create it with `aa` first.");
    const panel = await message.channel.send(makeApplicationPanel(found.application, found.key));
    await message.reply(`Application panel posted: ${panel}`);
  }
}

async function handlePrefixMessage(message, inviteData, ticketConfigs, giveaways, giveawayTimers, client, features) {
  if (!message.guild) {
    if (!message.author.bot) await handleApplicationDm(message, features.applications, features.pendingBuilders, features.interviews);
    return ticketConfigs;
  }
  if (message.author.bot) return ticketConfigs;
  const command = parsePrefixCommand(message.content);
  if (!command) return ticketConfigs;

  if (["ticketpost", "ticket-post"].includes(command.name)) {
    await postTicketPanel(message);
  } else if (["ticketconfig", "ticket-config"].includes(command.name)) {
    return await handlePrefixTicketConfig(message, command.args, ticketConfigs);
  } else if (command.name === "giveaway") {
    await handlePrefixGiveaway(message, command.args, giveaways, giveawayTimers, client);
  } else if (["rr", "reactionroles", "ra", "reactionadd"].includes(command.name)) {
    await handlePrefixReactionCommand(message, command, features.reactionRoles);
  } else if (["aa", "applyadd", "ar", "applicationrole", "ac", "applicationchannel", "ap", "applicationpost"].includes(command.name)) {
    await handlePrefixApplicationCommand(message, command, features);
  } else if (["mute", "kick", "ban"].includes(command.name)) {
    await runModerationCommand(message, command);
  } else if (command.name === "invites") {
    const requestedUser = message.mentions.users.first() ?? message.author;
    const totals = inviteData.totals[getInviterKey(message.guild.id, requestedUser.id)] ?? { joins: 0, left: 0 };
    await message.reply(`${requestedUser} has **${totals.joins}** tracked invite join(s) (${totals.left} left).`);
  }
  return ticketConfigs;
}

export function createClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildInvites,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
  });
  return client;
}

async function registerGuildInvites(guild, inviteCache) {
  const invites = await guild.invites.fetch();
  inviteCache.set(guild.id, new Map(invites.map((invite) => [invite.code, {
    uses: invite.uses ?? 0,
    inviterId: invite.inviter?.id ?? null,
  }])));
}

async function handleReactionRoleEvent(reaction, user, reactionRoles, addRole) {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch();
  if (reaction.message.partial) await reaction.message.fetch();
  const guild = reaction.message.guild;
  if (!guild) return;
  const roleId = reactionRoles[guild.id]?.[reaction.message.id]?.roles?.[getReactionKey(reaction.emoji)];
  if (!roleId) return;

  const role = guild.roles.cache.get(roleId);
  const botMember = guild.members.me;
  if (!role || !botMember?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= botMember.roles.highest.position) {
    console.error(`Reaction role ${roleId} for message ${reaction.message.id} is missing or not manageable.`);
    return;
  }
  const member = await guild.members.fetch(user.id);
  if (addRole) await member.roles.add(role, "Reaction role added");
  else await member.roles.remove(role, "Reaction role removed");
}

async function handleApplicationReview(interaction, action, applications) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "You need Manage Server to review applications.", ephemeral: true });
    return;
  }
  const submission = applications.submissions[interaction.message.id];
  if (!submission || submission.guildId !== interaction.guildId) {
    await interaction.reply({ content: "This application submission could not be found.", ephemeral: true });
    return;
  }
  if (submission.status !== "pending") {
    await interaction.reply({ content: `This application has already been ${submission.status}.`, ephemeral: true });
    return;
  }

  const application = applications.guilds[submission.guildId]?.applications?.[submission.applicationKey];
  const roleIds = action === "accept" ? application?.roleIds ?? [] : [];
  const roles = roleIds.map((id) => interaction.guild.roles.cache.get(id));
  const botMember = interaction.guild.members.me;
  if (!botMember || roles.some((role) => !role || role.managed || role.position >= botMember.roles.highest.position)) {
    await interaction.reply({ content: "One or more acceptance roles are missing or above the bot’s highest role.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  submission.status = "processing";
  submission.reviewerId = interaction.user.id;
  try {
    await saveApplications(applications);
  } catch (error) {
    submission.status = "pending";
    delete submission.reviewerId;
    throw error;
  }

  if (action === "accept" && roles.length) {
    try {
      const applicant = await interaction.guild.members.fetch(submission.applicantId);
      await applicant.roles.add(roles, `Application accepted by ${interaction.user.tag}`);
    } catch (error) {
      submission.status = "pending";
      delete submission.reviewerId;
      await saveApplications(applications).catch((saveError) => {
        console.error(`Could not reset application review ${submission.reviewMessageId}: ${saveError.message}`);
      });
      throw error;
    }
  }

  submission.status = action === "accept" ? "accepted" : "denied";
  submission.reviewerId = interaction.user.id;
  await saveApplications(applications);

  let dmSent = true;
  try {
    const applicant = await interaction.client.users.fetch(submission.applicantId);
    await applicant.send(
      action === "accept"
        ? `Your **${application?.name ?? "server"}** application has been accepted!`
        : `Your **${application?.name ?? "server"}** application has been denied.`,
    );
  } catch (error) {
    dmSent = false;
    console.error(`Could not DM application decision to ${submission.applicantId}: ${error.message}`);
  }

  const embed = EmbedBuilder.from(interaction.message.embeds[0])
    .setColor(action === "accept" ? 0x57f287 : 0xed4245)
    .setDescription(`Applicant: <@${submission.applicantId}> (\`${submission.applicantId}\`)\nStatus: **${submission.status === "accepted" ? "Accepted" : "Denied"}**`);
  const disabledRows = interaction.message.components.map((row) =>
    new ActionRowBuilder().addComponents(
      row.components.map((component) => ButtonBuilder.from(component).setDisabled(true)),
    ),
  );
  await interaction.message.edit({ embeds: [embed], components: disabledRows });
  await interaction.editReply(`${submission.status === "accepted" ? "Accepted" : "Denied"} the application.${dmSent ? "" : " I couldn’t DM the applicant."}`);
}

async function handleSlashReactionCommand(interaction, commandName, reactionRoles) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.reply({ content: "You need Manage Roles to configure reaction roles.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const role = interaction.options.getRole("role", true);
  if (["rr", "reactionroles"].includes(commandName)) {
    const message = await createReactionRoleMessage({
      guild: interaction.guild,
      channel: interaction.channel,
      actor: interaction.member,
      role,
      text: interaction.options.getString("message", true),
      emojiText: interaction.options.getString("emoji", true),
      reactionRoles,
    });
    await interaction.editReply(`Reaction-role message created: ${message}`);
    return;
  }

  const messageId = interaction.options.getString("message-id", true);
  const message = await findMessageInChannel(interaction.channel, messageId);
  if (!message) throw new Error("I couldn’t find that message in this channel.");
  const emoji = interaction.options.getString("emoji", true);
  await addReactionRoleToMessage({
    guild: interaction.guild,
    channel: interaction.channel,
    message,
    role,
    emojiText: emoji,
    actor: interaction.member,
    reactionRoles,
  });
  await interaction.editReply(`Added ${emoji} → ${role} to message \`${messageId}\`.`);
}

async function handleSlashApplicationCommand(interaction, commandName, features) {
  const { applications, pendingBuilders } = features;
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "You need Manage Server to configure applications.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  if (["aa", "applyadd"].includes(commandName)) {
    await startApplicationCommand(
      interaction.user,
      interaction.guildId,
      interaction.options.getString("name", true),
      applications,
      pendingBuilders,
    );
    await interaction.editReply("I’ve DM’d you to build the application. Answer the questions there.");
    return;
  }
  if (["ar", "applicationrole"].includes(commandName)) {
    const role = interaction.options.getRole("role", true);
    const name = interaction.options.getString("application", true);
    const found = findGuildApplication(applications, interaction.guildId, name);
    if (!found) throw new Error("I couldn’t find that application. Check its name or create it with `/aa` first.");
    assertRoleManageable(interaction.guild, interaction.member, role);
    const updated = ensureApplication(applications, interaction.guildId, found.key, {
      ...found.application,
      roleIds: [...new Set([...found.application.roleIds, role.id])],
    });
    await saveApplications(updated);
    Object.assign(applications, updated);
    await interaction.editReply(`Added ${role} as an acceptance role for **${found.application.name}**.`);
    return;
  }
  if (["ac", "applicationchannel"].includes(commandName)) {
    const channel = interaction.options.getChannel("channel", true);
    const updated = ensureGuildApplications(applications, interaction.guildId);
    updated.guilds[interaction.guildId].reviewChannelId = channel.id;
    await saveApplications(updated);
    Object.assign(applications, updated);
    await interaction.editReply(`Application reviews will be sent to ${channel}.`);
    return;
  }
  if (["ap", "applicationpost"].includes(commandName)) {
    const name = interaction.options.getString("application", true);
    const found = findGuildApplication(applications, interaction.guildId, name);
    if (!found) throw new Error("I couldn’t find that application. Check its name or create it with `/aa` first.");
    const panel = await interaction.channel.send(makeApplicationPanel(found.application, found.key));
    await interaction.editReply(`Application panel posted: ${panel}`);
  }
}

export async function startBot() {
  if (!process.env.DISCORD_TOKEN) throw new Error("Set DISCORD_TOKEN before starting the bot.");

  const client = createClient();
  const inviteCache = new Map();
  const inviteData = await loadInviteData();
  let ticketConfigs = await loadTicketConfigs();
  const giveaways = await loadGiveaways();
  const giveawayTimers = new Map();
  const reactionRoles = await loadReactionRoles();
  const applications = await loadApplications();
  const pendingBuilders = new Map();
  const interviews = new Map();
  const features = { reactionRoles, applications, pendingBuilders, interviews };

  client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}`);
    let recoverApplications = false;
    for (const submission of Object.values(applications.submissions)) {
      if (submission.status === "processing") {
        submission.status = "pending";
        delete submission.reviewerId;
        recoverApplications = true;
      }
    }
    if (recoverApplications) {
      try {
        await saveApplications(applications);
      } catch (error) {
        console.error(`Could not restore pending application reviews: ${error.message}`);
      }
    }
    let recoveredGiveaways = false;
    for (const [messageId, giveaway] of Object.entries(giveaways)) {
      if (giveaway.status === "ending") {
        giveaway.status = "active";
        recoveredGiveaways = true;
      }
      if (giveaway.status === "active") {
        scheduleGiveawayEnd(client, giveaways, giveawayTimers, messageId);
      }
    }
    if (recoveredGiveaways) await saveGiveaways(giveaways);
    for (const guild of client.guilds.cache.values()) {
      try {
        await registerGuildInvites(guild, inviteCache);
      } catch (error) {
        console.error(`Could not cache invites for ${guild.name}: ${error.message}`);
      }
    }
  });

  client.on("inviteCreate", async (invite) => {
    try {
      await registerGuildInvites(invite.guild, inviteCache);
    } catch (error) {
      console.error(`Could not refresh invites for ${invite.guild.name}: ${error.message}`);
    }
  });
  client.on("inviteDelete", async (invite) => {
    try {
      await registerGuildInvites(invite.guild, inviteCache);
    } catch (error) {
      console.error(`Could not refresh invites for ${invite.guild.name}: ${error.message}`);
    }
  });

  client.on("guildMemberAdd", async (member) => {
    try {
      const before = inviteCache.get(member.guild.id);
      if (!before) {
        await registerGuildInvites(member.guild, inviteCache);
        return;
      }
      const currentInvites = await member.guild.invites.fetch();
      const usedInvite = currentInvites.find((invite) => (invite.uses ?? 0) > (before.get(invite.code)?.uses ?? 0));
      inviteCache.set(member.guild.id, new Map(currentInvites.map((invite) => [invite.code, {
        uses: invite.uses ?? 0,
        inviterId: invite.inviter?.id ?? null,
      }])));

      const inviterId = usedInvite?.inviter?.id;
      if (!inviterId) return;
      const key = getInviterKey(member.guild.id, inviterId);
      const totals = inviteData.totals[key] ?? { joins: 0, left: 0 };
      totals.joins += 1;
      inviteData.totals[key] = totals;
      inviteData.members[member.guild.id] ??= {};
      inviteData.members[member.guild.id][member.id] = inviterId;
      await saveInviteData(inviteData);
    } catch (error) {
      console.error(`Could not track invite for ${member.user.tag}: ${error.message}`);
    }
  });

  client.on("guildMemberRemove", async (member) => {
    const guildMembers = inviteData.members[member.guild.id] ?? {};
    const inviterId = guildMembers[member.id];
    if (!inviterId) return;
    delete guildMembers[member.id];
    const totals = inviteData.totals[getInviterKey(member.guild.id, inviterId)];
    if (totals) totals.left += 1;
    try {
      await saveInviteData(inviteData);
    } catch (error) {
      console.error(`Could not save invite departure for ${member.user.tag}: ${error.message}`);
    }
  });

  client.on("messageReactionAdd", async (reaction, user) => {
    try {
      await handleReactionRoleEvent(reaction, user, reactionRoles, true);
    } catch (error) {
      console.error(`Could not grant reaction role: ${error.message}`);
    }
  });
  client.on("messageReactionRemove", async (reaction, user) => {
    try {
      await handleReactionRoleEvent(reaction, user, reactionRoles, false);
    } catch (error) {
      console.error(`Could not remove reaction role: ${error.message}`);
    }
  });

  client.on("messageCreate", async (message) => {
    try {
      ticketConfigs = await handlePrefixMessage(
        message,
        inviteData,
        ticketConfigs,
        giveaways,
        giveawayTimers,
        client,
        features,
      );
    } catch (error) {
      console.error(`Prefix command failed: ${error.message}`);
      await message.reply("That command failed. Check the bot’s permissions and try again.").catch((replyError) => {
        console.error(`Could not report command failure: ${replyError.message}`);
      });
    }
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === "ticket-post") {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageChannels)) {
          await interaction.reply({ content: "You need the Manage Channels permission to post a ticket panel.", ephemeral: true });
          return;
        }
        await interaction.channel.send(makeTicketPanel());
        await interaction.reply({ content: "Ticket panel posted.", ephemeral: true });
      } else if (interaction.isChatInputCommand() && interaction.commandName === "ticket-config") {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageChannels)) {
          await interaction.reply({ content: "You need the Manage Channels permission to configure ticket settings.", ephemeral: true });
          return;
        }

        const category = interaction.options.getChannel("category");
        const staffRole = interaction.options.getRole("staff-role");
        const clear = interaction.options.getString("clear");
        if (clear && (category || staffRole)) {
          await interaction.reply({ content: "Choose settings to update or a setting to clear, not both.", ephemeral: true });
          return;
        }

        if (clear) {
          const updated = clearTicketConfig(ticketConfigs, interaction.guildId, clear);
          await saveTicketConfigs(updated);
          ticketConfigs = updated;
          await interaction.reply({
            content: `Cleared ticket ${clear === "all" ? "settings" : clear + " setting"}.\n${ticketConfigSummary(interaction.guild, ticketConfigs)}`,
            ephemeral: true,
          });
          return;
        }

        const patch = {};
        if (category) patch.categoryId = category.id;
        if (staffRole?.id === interaction.guildId) {
          await interaction.reply({ content: "The @everyone role can’t be used as the ticket staff role.", ephemeral: true });
          return;
        }
        if (staffRole) patch.staffRoleId = staffRole.id;
        if (Object.keys(patch).length) {
          ticketConfigs = await saveGuildTicketConfig(ticketConfigs, interaction.guildId, patch);
          await interaction.reply({ content: `Ticket settings saved.\n${ticketConfigSummary(interaction.guild, ticketConfigs)}`, ephemeral: true });
        } else {
          await interaction.reply({ content: ticketConfigSummary(interaction.guild, ticketConfigs), ephemeral: true });
        }
      } else if (interaction.isChatInputCommand() && interaction.commandName === "giveaway") {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
          await interaction.reply({ content: "You need the Manage Server permission to start a giveaway.", ephemeral: true });
          return;
        }
        const prize = interaction.options.getString("prize", true).trim();
        const durationText = interaction.options.getString("duration", true);
        const duration = parseGiveawayDuration(durationText);
        const winnerCount = interaction.options.getInteger("winners") ?? 1;
        if (!duration) {
          await interaction.reply({ content: "Giveaway duration must be from 1 minute to 30 days (for example `30m`, `2h`, or `1d`).", ephemeral: true });
          return;
        }
        if (!prize) {
          await interaction.reply({ content: "Enter a prize for the giveaway.", ephemeral: true });
          return;
        }
        await interaction.deferReply({ ephemeral: true });
        const giveawayMessage = await startGiveaway({
          channel: interaction.channel,
          host: interaction.user,
          prize,
          duration,
          winnerCount,
          giveaways,
          giveawayTimers,
          client,
        });
        await interaction.editReply({ content: `Giveaway started: ${giveawayMessage}` });
      } else if (interaction.isChatInputCommand() && [
        "rr", "reactionroles", "ra", "reactionadd",
      ].includes(interaction.commandName)) {
        await handleSlashReactionCommand(interaction, interaction.commandName, reactionRoles);
      } else if (interaction.isChatInputCommand() && [
        "aa", "applyadd", "ar", "applicationrole", "ac", "applicationchannel", "ap", "applicationpost",
      ].includes(interaction.commandName)) {
        await handleSlashApplicationCommand(interaction, interaction.commandName, features);
      } else if (interaction.isButton() && interaction.customId.startsWith(APPLICATION_REVIEW_PREFIX)) {
        const [, action, messageId] = interaction.customId.slice(APPLICATION_REVIEW_PREFIX.length).match(/^(accept|deny):(\d{17,20})$/) ?? [];
        if (!action || messageId !== interaction.message.id) {
          await interaction.reply({ content: "This application review button is invalid.", ephemeral: true });
          return;
        }
        await handleApplicationReview(interaction, action, applications);
      } else if (interaction.isButton() && interaction.customId.startsWith(APPLICATION_PANEL_PREFIX)) {
        await beginApplicationInterview(interaction, applications, interviews);
      } else if (interaction.isButton() && interaction.customId === GIVEAWAY_BUTTON_ID) {
        await enterGiveaway(interaction, giveaways);
      } else if (interaction.isButton() && interaction.customId === TICKET_BUTTON_ID) {
        await interaction.showModal(makeTicketModal());
      } else if (interaction.isModalSubmit() && interaction.customId === TICKET_MODAL_ID) {
        await createTicket(interaction, ticketConfigs);
      } else if (interaction.isButton() && interaction.customId === TICKET_CLOSE_ID) {
        const ownerId = interaction.channel.topic?.match(/^ticket-owner:(\d+)$/)?.[1];
        const isOwner = interaction.user.id === ownerId;
        const isStaff = interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);
        if (!isOwner && !isStaff) {
          await interaction.reply({ content: "Only the ticket opener or a moderator can close this ticket.", ephemeral: true });
          return;
        }
        await interaction.reply({ content: "Closing this ticket…" });
        await interaction.channel.delete(`Ticket closed by ${interaction.user.tag}`);
      }
    } catch (error) {
      console.error(`Interaction failed: ${error.message}`);
      if (interaction.isRepliable() && interaction.deferred) {
        await interaction.editReply({ content: "That action failed. Check the bot’s permissions and try again." })
          .catch((replyError) => console.error(`Could not report interaction failure: ${replyError.message}`));
      } else if (interaction.isRepliable() && !interaction.replied) {
        await interaction.reply({ content: "That action failed. Check the bot’s permissions and try again.", ephemeral: true })
          .catch((replyError) => console.error(`Could not report interaction failure: ${replyError.message}`));
      }
    }
  });

  await client.login(process.env.DISCORD_TOKEN);
  return client;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await startBot();
}
