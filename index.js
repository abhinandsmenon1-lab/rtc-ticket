require("dotenv").config();

const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionsBitField,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  UserSelectMenuBuilder,
  AttachmentBuilder,
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = "*";

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

// Small web server for hosts that need a port.
const app = express();
app.get("/", (_req, res) => res.send("RTC Ticket Bot is running."));
app.listen(process.env.PORT || 3000, () => console.log("Keep-alive web server ready."));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// In-memory storage.
// For serious long-term hosting, replace this with SQLite/JSON DB.
// Good enough for simple hosting and testing.
const panelSetups = new Map();
const panels = new Map(); // messageId -> panel config
const tickets = new Map(); // channelId -> ticket data
let ticketCounter = 1;

function isAdmin(member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator);
}

function safeName(name) {
  return String(name || "user")
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40);
}

function ticketEmbed(ticket, state = "open") {
  const color = state === "closed" ? 0xff4b4b : ticket.claimedBy ? 0xf59e0b : 0xffb000;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(state === "closed" ? "🔒 Ticket Closed" : "Middleman Request")
    .addFields(
      { name: state === "closed" ? "Opened By" : "Requester", value: `<@${ticket.openerId}>`, inline: true },
      { name: "Other User", value: ticket.otherUserId ? `<@${ticket.otherUserId}>` : "Not selected", inline: true },
      { name: "Trade Details", value: ticket.tradeDetails || "No details", inline: false },
    );

  if (ticket.claimedBy) {
    embed.addFields({ name: "Claimed By", value: `<@${ticket.claimedBy}>`, inline: true });
  }

  if (state === "closed" && ticket.closedBy) {
    embed.addFields({ name: "Closed By", value: `<@${ticket.closedBy}>`, inline: true });
    embed.setFooter({ text: `Ticket #${ticket.number}` });
  }

  return embed;
}

function ticketButtons(ticket) {
  const claimed = Boolean(ticket.claimedBy);

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_claim")
      .setLabel("Claim")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(claimed),
    new ButtonBuilder()
      .setCustomId("ticket_unclaim")
      .setLabel("Unclaim")
      .setEmoji("🔓")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!claimed),
    new ButtonBuilder()
      .setCustomId("ticket_close")
      .setLabel("Close")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Danger),
  );
}

function canHandleTicket(member, ticket) {
  if (!ticket) return false;
  if (isAdmin(member)) return true;
  if (ticket.claimedBy) return member.id === ticket.claimedBy;
  return member.roles.cache.has(ticket.handlerRoleId);
}

function canSeeAsHandler(member, ticket) {
  return isAdmin(member) || member.roles.cache.has(ticket.handlerRoleId);
}

async function refreshTicketMessage(channel, ticket) {
  if (!ticket.controlMessageId) return;
  try {
    const msg = await channel.messages.fetch(ticket.controlMessageId);
    await msg.edit({ embeds: [ticketEmbed(ticket)], components: [ticketButtons(ticket)] });
  } catch {}
}

async function claimTicket(channel, member, source) {
  const ticket = tickets.get(channel.id);
  if (!ticket) return reply(source, "❌ This is not a ticket channel.", true);
  if (!canSeeAsHandler(member, ticket)) return reply(source, "❌ You are not allowed to claim this ticket.", true);
  if (ticket.claimedBy) return reply(source, `❌ This ticket is already claimed by <@${ticket.claimedBy}>.`, true);

  ticket.claimedBy = member.id;

  await channel.permissionOverwrites.edit(ticket.handlerRoleId, {
    ViewChannel: false,
    SendMessages: false,
  }).catch(() => null);

  await channel.permissionOverwrites.edit(member.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
  }).catch(() => null);

  await refreshTicketMessage(channel, ticket);
  await channel.send(`✅ Claimed by <@${member.id}>`);
  return reply(source, "✅ Ticket claimed.", true);
}

async function unclaimTicket(channel, member, source) {
  const ticket = tickets.get(channel.id);
  if (!ticket) return reply(source, "❌ This is not a ticket channel.", true);
  if (!ticket.claimedBy) return reply(source, "❌ This ticket is not claimed.", true);
  if (!isAdmin(member) && member.id !== ticket.claimedBy) {
    return reply(source, "❌ Only the person who claimed this ticket can unclaim it.", true);
  }

  const old = ticket.claimedBy;
  ticket.claimedBy = null;

  await channel.permissionOverwrites.delete(old).catch(() => null);
  await channel.permissionOverwrites.edit(ticket.handlerRoleId, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
  }).catch(() => null);

  await refreshTicketMessage(channel, ticket);
  await channel.send(`🔓 Ticket unclaimed by <@${member.id}>`);
  return reply(source, "🔓 Ticket unclaimed.", true);
}

async function addUserToTicket(channel, member, user, source) {
  const ticket = tickets.get(channel.id);
  if (!ticket) return reply(source, "❌ This is not a ticket channel.", true);
  if (!canHandleTicket(member, ticket)) return reply(source, "❌ You cannot add users to this ticket.", true);

  await channel.permissionOverwrites.edit(user.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
  });

  await channel.send(`➕ Added <@${user.id}> to the ticket.`);
  return reply(source, `✅ Added ${user}.`, true);
}

async function transferTicket(channel, member, user, source) {
  const ticket = tickets.get(channel.id);
  if (!ticket) return reply(source, "❌ This is not a ticket channel.", true);
  if (!ticket.claimedBy) return reply(source, "❌ Ticket must be claimed before transfer.", true);
  if (!isAdmin(member) && member.id !== ticket.claimedBy) {
    return reply(source, "❌ Only the current handler can transfer this ticket.", true);
  }

  const guildMember = await channel.guild.members.fetch(user.id).catch(() => null);
  if (!guildMember) return reply(source, "❌ User not found in server.", true);
  if (!canSeeAsHandler(guildMember, ticket)) return reply(source, "❌ That user does not have the handler role.", true);

  const old = ticket.claimedBy;
  ticket.claimedBy = user.id;

  await channel.permissionOverwrites.delete(old).catch(() => null);
  await channel.permissionOverwrites.edit(user.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
  }).catch(() => null);

  await refreshTicketMessage(channel, ticket);
  await channel.send(`🔁 Ticket transferred from <@${old}> to <@${user.id}>`);
  return reply(source, "✅ Ticket transferred.", true);
}

async function closeTicket(channel, member, source) {
  const ticket = tickets.get(channel.id);
  if (!ticket) return reply(source, "❌ This is not a ticket channel.", true);
  if (!canHandleTicket(member, ticket)) {
    return reply(source, "❌ Only the person who claimed this ticket can close it.", true);
  }

  ticket.closedBy = member.id;

  await reply(source, "🔒 Saving transcript and closing ticket...", false).catch(() => null);
  await channel.send("🔒 Saving transcript and closing ticket...").catch(() => null);

  const html = await makeTranscript(channel, ticket);
  const file = new AttachmentBuilder(Buffer.from(html, "utf8"), { name: `ticket-${ticket.number}-transcript.html` });

  const closedEmbed = ticketEmbed(ticket, "closed");
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("📄 View Transcript")
      .setStyle(ButtonStyle.Secondary)
      .setCustomId("disabled_transcript")
      .setDisabled(true)
  );

  const transcriptChannel = await channel.guild.channels.fetch(ticket.transcriptChannelId).catch(() => null);
  if (transcriptChannel) {
    await transcriptChannel.send({
      embeds: [closedEmbed],
      components: [row],
      files: [file],
    });
  }

  tickets.delete(channel.id);
  setTimeout(() => channel.delete(`Ticket closed by ${member.user.tag}`).catch(() => null), 3000);
}

async function makeTranscript(channel, ticket) {
  let all = [];
  let lastId;

  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const batch = await channel.messages.fetch(options);
    if (!batch.size) break;
    all.push(...batch.values());
    lastId = batch.last().id;
    if (all.length >= 1000) break;
  }

  all = all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const rows = all.map(m => {
    const author = escapeHtml(m.author?.tag || "Unknown");
    const avatar = m.author?.displayAvatarURL?.({ extension: "png" }) || "";
    const time = new Date(m.createdTimestamp).toLocaleString();
    const content = escapeHtml(m.content || "");
    const attachments = [...m.attachments.values()].map(a => `<br><a href="${escapeHtml(a.url)}">${escapeHtml(a.name || "attachment")}</a>`).join("");
    return `<div class="msg">
      <img src="${avatar}" class="avatar">
      <div><b>${author}</b> <span>${time}</span><p>${content || "<i>No text content</i>"}${attachments}</p></div>
    </div>`;
  }).join("\n");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Ticket #${ticket.number} Transcript</title>
<style>
body { margin:0; background:#2b2d31; color:#dbdee1; font-family: Arial, sans-serif; }
.header { padding:28px; border-bottom:1px solid #1e1f22; }
h1 { margin:0 0 12px; color:white; }
.meta { color:#b5bac1; }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:14px; padding:24px; border-bottom:1px solid #1e1f22; }
.card { background:#1e1f22; padding:16px; border-radius:8px; }
.card b { display:block; color:#b5bac1; font-size:12px; text-transform:uppercase; letter-spacing:.08em; margin-bottom:8px; }
.card span { color:#5865f2; font-weight:bold; }
.messages { max-width:900px; margin:30px auto; }
.msg { display:flex; gap:14px; padding:10px; }
.avatar { width:42px; height:42px; border-radius:50%; }
.msg span { color:#a5acb8; font-size:12px; margin-left:6px; }
.msg p { margin:6px 0 0; white-space:pre-wrap; }
.footer { text-align:center; color:#777; padding:30px; border-top:1px solid #1e1f22; }
</style>
</head>
<body>
<div class="header">
  <h1>🎟️ Ticket #${ticket.number} Transcript</h1>
  <div class="meta">Opened ${new Date(ticket.openedAt).toLocaleString()} · Closed ${new Date().toLocaleString()}</div>
</div>
<div class="cards">
  <div class="card"><b>Opened By</b><span>@user:${ticket.openerId}</span></div>
  <div class="card"><b>Other User</b><span>@user:${ticket.otherUserId || "none"}</span></div>
  <div class="card"><b>Trade Details</b>${escapeHtml(ticket.tradeDetails || "None")}</div>
  <div class="card"><b>Claimed By</b><span>@user:${ticket.claimedBy || "none"}</span></div>
  <div class="card"><b>Closed By</b><span>@user:${ticket.closedBy || "none"}</span></div>
</div>
<div class="messages">${rows}</div>
<div class="footer">Discord Ticket Transcript · ${all.length} messages</div>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}

async function reply(source, content, ephemeral = true) {
  if (!source) return;
  if (source.deferred || source.replied) return source.followUp({ content, ephemeral });
  if (source.reply) return source.reply({ content, ephemeral });
  if (source.channel) return source.channel.send(content);
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === "panelcreate") {
        if (!isAdmin(interaction.member)) return interaction.reply({ content: "❌ Admin only.", ephemeral: true });

        panelSetups.set(interaction.user.id, { step: 1 });

        const row = new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId("setup_panel_channel")
            .setPlaceholder("Select the channel for the panel")
            .setChannelTypes(ChannelType.GuildText)
            .setMinValues(1)
            .setMaxValues(1)
        );

        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865f2)
              .setTitle("Panel Setup (1/6)")
              .setDescription("Select the **channel** where the panel message will be posted.")
          ],
          components: [row],
          ephemeral: true,
        });
      }

      const channel = interaction.channel;
      const member = interaction.member;

      if (commandName === "claim") return claimTicket(channel, member, interaction);
      if (commandName === "unclaim") return unclaimTicket(channel, member, interaction);
      if (commandName === "close") return closeTicket(channel, member, interaction);
      if (commandName === "add") return addUserToTicket(channel, member, interaction.options.getUser("user"), interaction);
      if (commandName === "transfer") return transferTicket(channel, member, interaction.options.getUser("user"), interaction);
    }

    if (interaction.isChannelSelectMenu()) {
      const setup = panelSetups.get(interaction.user.id);
      if (!setup) return;

      if (interaction.customId === "setup_panel_channel") {
        setup.panelChannelId = interaction.values[0];
        setup.step = 2;

        const row = new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId("setup_ticket_category")
            .setPlaceholder("Select the category for new tickets")
            .setChannelTypes(ChannelType.GuildCategory)
            .setMinValues(1)
            .setMaxValues(1)
        );

        return interaction.update({
          embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("Panel Setup (2/6)").setDescription("Select the **category** where tickets should open.")],
          components: [row],
        });
      }

      if (interaction.customId === "setup_ticket_category") {
        setup.categoryId = interaction.values[0];
        setup.step = 3;

        const row = new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId("setup_transcript_channel")
            .setPlaceholder("Select the transcript channel")
            .setChannelTypes(ChannelType.GuildText)
            .setMinValues(1)
            .setMaxValues(1)
        );

        return interaction.update({
          embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("Panel Setup (3/6)").setDescription("Select the **channel** where transcripts should be posted.")],
          components: [row],
        });
      }

      if (interaction.customId === "setup_transcript_channel") {
        setup.transcriptChannelId = interaction.values[0];
        setup.step = 4;

        const row = new ActionRowBuilder().addComponents(
          new RoleSelectMenuBuilder()
            .setCustomId("setup_handler_role")
            .setPlaceholder("Select the handler/middleman role")
            .setMinValues(1)
            .setMaxValues(1)
        );

        return interaction.update({
          embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("Panel Setup (4/6)").setDescription("Select the **role** that can see, claim, and get pinged for tickets.")],
          components: [row],
        });
      }
    }

    if (interaction.isRoleSelectMenu()) {
      const setup = panelSetups.get(interaction.user.id);
      if (!setup) return;

      if (interaction.customId === "setup_handler_role") {
        setup.handlerRoleId = interaction.values[0];
        setup.step = 5;

        const modal = new ModalBuilder()
          .setCustomId("setup_text_modal")
          .setTitle("Panel Setup (5/6)");

        const naming = new TextInputBuilder()
          .setCustomId("naming_scheme")
          .setLabel("Ticket naming scheme")
          .setPlaceholder("e.g. mm -> channel will be named mm-username")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const message = new TextInputBuilder()
          .setCustomId("panel_message")
          .setLabel("Panel message")
          .setPlaceholder("e.g. Click below to open a middleman ticket...")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(naming),
          new ActionRowBuilder().addComponents(message),
        );

        return interaction.showModal(modal);
      }
    }

    if (interaction.isUserSelectMenu()) {
      if (interaction.customId.startsWith("select_other_trader:")) {
        const panelMsgId = interaction.customId.split(":")[1];
        const panel = panels.get(panelMsgId);
        if (!panel) return interaction.reply({ content: "❌ Panel config missing. Create panel again.", ephemeral: true });

        const otherUserId = interaction.values[0];

        if (otherUserId === interaction.user.id) {
          return interaction.reply({ content: "❌ Select the other trader, not yourself.", ephemeral: true });
        }

        const modal = new ModalBuilder()
          .setCustomId(`ticket_open_modal:${panelMsgId}:${otherUserId}`)
          .setTitle("Request Middleman");

        const details = new TextInputBuilder()
          .setCustomId("trade_details")
          .setLabel("What is the trade?")
          .setPlaceholder("Explain the deal/trade details")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(details));
        return interaction.showModal(modal);
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === "setup_text_modal") {
        const setup = panelSetups.get(interaction.user.id);
        if (!setup) return interaction.reply({ content: "❌ Setup expired. Run /panelcreate again.", ephemeral: true });

        setup.namingScheme = interaction.fields.getTextInputValue("naming_scheme");
        setup.panelMessage = interaction.fields.getTextInputValue("panel_message");

        const panelChannel = await interaction.guild.channels.fetch(setup.panelChannelId);
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setDescription(setup.panelMessage)
          .setFooter({ text: "Click the button below to open a ticket" });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("open_ticket")
            .setLabel("Open Ticket")
            .setEmoji("🎟️")
            .setStyle(ButtonStyle.Primary)
        );

        const msg = await panelChannel.send({ embeds: [embed], components: [row] });

        panels.set(msg.id, {
          panelChannelId: setup.panelChannelId,
          categoryId: setup.categoryId,
          transcriptChannelId: setup.transcriptChannelId,
          handlerRoleId: setup.handlerRoleId,
          namingScheme: setup.namingScheme,
          panelMessage: setup.panelMessage,
        });

        panelSetups.delete(interaction.user.id);

        return interaction.reply({ content: `✅ Panel created in ${panelChannel}.`, ephemeral: true });
      }

      if (interaction.customId.startsWith("ticket_open_modal:")) {
        const parts = interaction.customId.split(":");
        const panelMsgId = parts[1];
        const otherUserId = parts[2] || "";
        const panel = panels.get(panelMsgId);
        if (!panel) return interaction.reply({ content: "❌ Panel config not found. Create panel again.", ephemeral: true });

        const tradeDetails = interaction.fields.getTextInputValue("trade_details");

        const member = interaction.member;
        const channelName = `${safeName(panel.namingScheme)}-${safeName(member.user.username)}`;

        const overwrites = [
          {
            id: interaction.guild.id,
            deny: [PermissionsBitField.Flags.ViewChannel],
          },
          {
            id: interaction.user.id,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
          },
          {
            id: panel.handlerRoleId,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
          },
          {
            id: client.user.id,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory],
          },
        ];

        if (/^\d{17,20}$/.test(otherUserId)) {
          overwrites.push({
            id: otherUserId,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
          });
        }

        const channel = await interaction.guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: panel.categoryId,
          permissionOverwrites: overwrites,
          topic: `ticket_owner=${interaction.user.id}; other=${otherUserId || "none"}`,
        });

        const ticket = {
          number: ticketCounter++,
          channelId: channel.id,
          openerId: interaction.user.id,
          otherUserId: /^\d{17,20}$/.test(otherUserId) ? otherUserId : null,
          tradeDetails,
          handlerRoleId: panel.handlerRoleId,
          transcriptChannelId: panel.transcriptChannelId,
          claimedBy: null,
          closedBy: null,
          openedAt: Date.now(),
          controlMessageId: null,
        };

        tickets.set(channel.id, ticket);

        const sent = await channel.send({
          content: `<@&${panel.handlerRoleId}> — New ticket opened by <@${interaction.user.id}>`,
          embeds: [ticketEmbed(ticket)],
          components: [ticketButtons(ticket)],
        });

        ticket.controlMessageId = sent.id;

        return interaction.reply({ content: `✅ Ticket created: ${channel}`, ephemeral: true });
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === "open_ticket") {
        const panel = panels.get(interaction.message.id);
        if (!panel) return interaction.reply({ content: "❌ Panel config missing. Create panel again.", ephemeral: true });

        const row = new ActionRowBuilder().addComponents(
          new UserSelectMenuBuilder()
            .setCustomId(`select_other_trader:${interaction.message.id}`)
            .setPlaceholder("Who is the other trader?")
            .setMinValues(1)
            .setMaxValues(1)
        );

        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865f2)
              .setTitle("Request Middleman")
              .setDescription("Select the **other trader** below. After that, the bot will ask for trade details.")
          ],
          components: [row],
          ephemeral: true,
        });
      }

      const channel = interaction.channel;
      const member = interaction.member;

      if (interaction.customId === "ticket_claim") return claimTicket(channel, member, interaction);
      if (interaction.customId === "ticket_unclaim") return unclaimTicket(channel, member, interaction);
      if (interaction.customId === "ticket_close") return closeTicket(channel, member, interaction);
    }
  } catch (err) {
    console.error(err);
    const msg = "❌ Error: " + (err.message || "Unknown error");
    if (interaction.replied || interaction.deferred) interaction.followUp({ content: msg, ephemeral: true }).catch(() => null);
    else interaction.reply({ content: msg, ephemeral: true }).catch(() => null);
  }
});

client.on("messageCreate", async message => {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();

  if (!command) return;

  try {
    if (command === "claim") return claimTicket(message.channel, message.member, message);
    if (command === "unclaim") return unclaimTicket(message.channel, message.member, message);
    if (command === "close") return closeTicket(message.channel, message.member, message);

    if (command === "add") {
      const user = message.mentions.users.first() || await client.users.fetch(args[0]).catch(() => null);
      if (!user) return message.reply("❌ Mention a user or give user ID.");
      return addUserToTicket(message.channel, message.member, user, message);
    }

    if (command === "transfer") {
      const user = message.mentions.users.first() || await client.users.fetch(args[0]).catch(() => null);
      if (!user) return message.reply("❌ Mention a user or give user ID.");
      return transferTicket(message.channel, message.member, user, message);
    }
  } catch (err) {
    console.error(err);
    message.reply("❌ Error: " + (err.message || "Unknown error")).catch(() => null);
  }
});

client.login(TOKEN);
