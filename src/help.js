import { EmbedBuilder } from "discord.js";
import { slashCommands } from "./commands.js";

export function createHelpEmbed() {
  const slashCommandList = slashCommands
    .map(({ name, description }) => `\`/${name}\` — ${description}`)
    .join("\n");

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("CosmixMC Bot Commands")
    .setDescription("Slash commands are listed below. Prefix commands work with `.`, `-`, or `_`.")
    .addFields(
      { name: "Slash commands", value: slashCommandList },
      {
        name: "Moderation and invites (prefix only)",
        value: [
          "`mute @member 10m [reason]` — timeout a member (up to 28 days).",
          "`kick @member [reason]` — kick a member.",
          "`ban @member [reason]` — ban a member.",
          "`invites [@member]` — show tracked invite counts.",
        ].join("\n"),
      },
      {
        name: "Tickets (prefix aliases)",
        value: [
          "`ticketpost` / `ticket-post` — post a ticket panel.",
          "`ticketconfig show` — show ticket settings.",
          "`ticketconfig category #channel` — set the ticket category.",
          "`ticketconfig staffrole @role` — set the ticket staff role.",
          "`ticketconfig clear category|staffrole|all` — clear saved settings.",
        ].join("\n"),
      },
      {
        name: "Giveaways and reaction roles (prefix aliases)",
        value: [
          "`giveaway 2h [winner-count] prize` — start a giveaway.",
          "`rr @role message text emoji` / `reactionroles ...` — post a reaction-role message.",
          "`ra MESSAGE_ID emoji @role` / `reactionadd ...` — add a reaction role to a message.",
        ].join("\n"),
      },
      {
        name: "Applications (prefix aliases)",
        value: [
          "`aa name` / `applyadd name` — create an application using DMs.",
          "`ar @role application name` / `applicationrole ...` — add an acceptance role.",
          "`ac #channel` / `applicationchannel ...` — set the review channel.",
          "`ap application name` / `applicationpost ...` — post an application panel.",
        ].join("\n"),
      },
    )
    .setFooter({ text: "Some commands require Manage Channels, Manage Roles, or Manage Server." });
}
