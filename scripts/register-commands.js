// Registers slash commands in the Akasha guild. Run once, and again after changing commands.js.
import { REST, Routes } from 'discord.js';
import { config } from '../src/config.js';
import { commands } from '../src/discord/commands.js';

if (!config.token || !config.appId || !config.guildId) {
  console.error('Set DISCORD_TOKEN, DISCORD_APP_ID and GUILD_ID in .env first.');
  process.exit(1);
}
const rest = new REST().setToken(config.token);
const data = await rest.put(Routes.applicationGuildCommands(config.appId, config.guildId), { body: commands });
console.log(`Registered ${data.length} commands: ${data.map((c) => `/${c.name}`).join(', ')}`);
