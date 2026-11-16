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

const PREFIXES = [".", "-", "_"];
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
const DATA_FILE = path.resolve("data/invites.json");
const TICKET_BUTTON_ID = "cosmixmc:ticket-open";
const TICKET_MODAL_ID = "cosmixmc:ticket-issue";
const TICKET_CLOSE_ID = "cosmixmc:ticket-close";
const GIVEAWAY_BUTTON_ID = "cosmixmc:giveaway-enter";
const MAX_GIVEAWAY_TIMER_MS = 2_147_483_647;

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

async function handlePrefixMessage(message, inviteData, ticketConfigs, giveaways, giveawayTimers, client) {
  if (!message.guild || message.author.bot) return ticketConfigs;
  const command = parsePrefixCommand(message.content);
  if (!command) return ticketConfigs;

  if (["ticketpost", "ticket-post"].includes(command.name)) {
    await postTicketPanel(message);
  } else if (["ticketconfig", "ticket-config"].includes(command.name)) {
    return await handlePrefixTicketConfig(message, command.args, ticketConfigs);
  } else if (command.name === "giveaway") {
    await handlePrefixGiveaway(message, command.args, giveaways, giveawayTimers, client);
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
    ],
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

export async function startBot() {
  if (!process.env.DISCORD_TOKEN) throw new Error("Set DISCORD_TOKEN before starting the bot.");

  const client = createClient();
  const inviteCache = new Map();
  const inviteData = await loadInviteData();
  let ticketConfigs = await loadTicketConfigs();
  const giveaways = await loadGiveaways();
  const giveawayTimers = new Map();

  client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}`);
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

  client.on("messageCreate", async (message) => {
    try {
      ticketConfigs = await handlePrefixMessage(
        message,
        inviteData,
        ticketConfigs,
        giveaways,
        giveawayTimers,
        client,
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
