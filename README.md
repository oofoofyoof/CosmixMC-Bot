# CosmixMC Core Bot

A Discord.js bot with moderation, invite tracking, and private support tickets.

## Setup

1. Install Node.js 20.18.0 or newer and run `npm install`.
2. Copy `.env.example` to `.env`. Set `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`. Optionally set a test server in `DISCORD_GUILD_ID`; `TICKET_CATEGORY_ID` and `TICKET_STAFF_ROLE_ID` are fallback defaults that can be overridden per server with bot commands.
3. In the Discord Developer Portal, enable the **Server Members Intent** and **Message Content Intent**. Invite the bot with the `bot` and `applications.commands` scopes. Grant it View Channels, Send Messages, Read Message History, Manage Channels, Moderate Members, Kick Members, Ban Members, and Manage Server (for invite tracking). Place its role above members it needs to moderate.
4. Run `npm run deploy-commands` to register `/ticket-post`, `/ticket-config`, and `/giveaway`. Guild registration via `DISCORD_GUILD_ID` is immediate; global registration can take time to appear.
5. Run `npm start`.

## Commands

All prefix commands accept `.`, `-`, or `_`:

- `mute @member 10m [reason]` — timeout a member (up to 28 days; supports `s`, `m`, `h`, `d`, and `w`).
- `kick @member [reason]`
- `ban @member [reason]`
- `invites [@member]` — show tracked invite joins and how many of those members later left.
- `ticketpost` or `ticket-post` — post the support panel in the current channel. `/ticket-post` does the same.
- `ticketconfig category #category` and `ticketconfig staffrole @role` — set where tickets are created and which staff role can see them. `/ticket-config` accepts optional `category` and `staff-role` options to set either or both.
- `ticketconfig show` or `/ticket-config` — view current settings. Use `ticketconfig clear category|staffrole|all` or `/ticket-config clear:...` to remove saved overrides.
- `giveaway 2h 1 Minecraft rank` — start a giveaway in the current channel. `/giveaway` takes a prize and duration, plus an optional winner count. Durations range from 1 minute to 30 days; starting giveaways requires Manage Server.

Giveaway entries are collected with a button, winners are selected when the giveaway ends, and active giveaways and entries are saved in `data/giveaways.json` so they resume after a restart. Ticket configuration commands require Manage Channels. Settings are saved per server in `data/ticket-config.json`; environment values are used as defaults, and staff roles with Manage Channels/Admin are inferred when no staff role is configured. Clicking **Create ticket** opens a form that asks for the issue. Submitting it creates a private channel visible to the opener, the bot, and staff, and displays the submitted issue in that channel. The opener or a moderator can close the ticket.

Invite attribution and totals are saved in `data/invites.json`. Counts include joins the bot observes after it starts tracking invites; earlier invite history cannot be reconstructed. Invite fetching requires the bot's Manage Server permission.