import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

export const slashCommands = [
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show the bot's commands.")
    .toJSON(),
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
  ...["reactionroles", "rr"].map((name) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription("Create a message with a reaction role.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addRoleOption((option) => option.setName("role").setDescription("Role granted by the reaction.").setRequired(true))
      .addStringOption((option) => option.setName("message").setDescription("Text for the reaction-role message.").setRequired(true).setMaxLength(1800))
      .addStringOption((option) => option.setName("emoji").setDescription("Emoji users react with.").setRequired(true).setMaxLength(100))
      .toJSON(),
  ),
  ...["reactionadd", "ra"].map((name) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription("Add a reaction role to a message in this channel.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addStringOption((option) => option.setName("message-id").setDescription("ID of the existing message in this channel.").setRequired(true))
      .addStringOption((option) => option.setName("emoji").setDescription("Emoji users react with.").setRequired(true).setMaxLength(100))
      .addRoleOption((option) => option.setName("role").setDescription("Role granted by the reaction.").setRequired(true))
      .toJSON(),
  ),
  ...["applyadd", "aa"].map((name) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription("Create an application by answering setup questions in DMs.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((option) => option.setName("name").setDescription("Name of the application.").setRequired(true).setMaxLength(80))
      .toJSON(),
  ),
  ...["applicationrole", "ar"].map((name) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription("Add an acceptance role to an application.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addRoleOption((option) => option.setName("role").setDescription("Role granted when accepted.").setRequired(true))
      .addStringOption((option) => option.setName("application").setDescription("Application name.").setRequired(true).setMaxLength(80))
      .toJSON(),
  ),
  ...["applicationchannel", "ac"].map((name) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription("Set the channel where applications are reviewed.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addChannelOption((option) => option.setName("channel").setDescription("Application review channel.").addChannelTypes(ChannelType.GuildText).setRequired(true))
      .toJSON(),
  ),
  ...["applicationpost", "ap"].map((name) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription("Post an application panel in this channel.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((option) => option.setName("application").setDescription("Application to post.").setRequired(true).setMaxLength(80))
      .toJSON(),
  ),
];
