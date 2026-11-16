import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

export const slashCommands = [
  new SlashCommandBuilder()
    .setName("ticket-config")
    .setDescription("Configure the ticket category and staff role for this server.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) =>
      option
        .setName("category")
        .setDescription("Category where ticket channels should be created.")
        .addChannelTypes(ChannelType.GuildCategory),
    )
    .addRoleOption((option) =>
      option
        .setName("staff-role")
        .setDescription("Role that can view and reply in tickets."),
    )
    .addStringOption((option) =>
      option
        .setName("clear")
        .setDescription("Remove saved settings and use the environment defaults.")
        .addChoices(
          { name: "Category", value: "category" },
          { name: "Staff role", value: "staff-role" },
          { name: "All settings", value: "all" },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("ticket-post")
    .setDescription("Post a panel for opening support tickets.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("giveaway")
    .setDescription("Start a giveaway in this channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) =>
      option
        .setName("prize")
        .setDescription("What the winner(s) will receive.")
        .setRequired(true)
        .setMaxLength(256),
    )
    .addStringOption((option) =>
      option
        .setName("duration")
        .setDescription("How long the giveaway runs (for example 30m, 2h, or 1d).")
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("winners")
        .setDescription("Number of winners (defaults to 1).")
        .setMinValue(1)
        .setMaxValue(20),
    )
    .toJSON(),
];
