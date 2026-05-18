require("dotenv").config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("panelcreate")
    .setDescription("Create a ticket panel")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("claim")
    .setDescription("Claim the current ticket"),

  new SlashCommandBuilder()
    .setName("unclaim")
    .setDescription("Unclaim the current ticket"),

  new SlashCommandBuilder()
    .setName("close")
    .setDescription("Close the current ticket"),

  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Add a user to the current ticket")
    .addUserOption(option =>
      option.setName("user")
        .setDescription("User to add")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("transfer")
    .setDescription("Transfer this ticket claim to another handler")
    .addUserOption(option =>
      option.setName("user")
        .setDescription("New handler")
        .setRequired(true)
    ),
].map(c => c.toJSON());

async function main() {
  if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
    console.error("Missing DISCORD_TOKEN or CLIENT_ID in .env");
    process.exit(1);
  }

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  console.log("Deploying slash commands...");
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  console.log("Slash commands deployed.");
}

main().catch(console.error);
