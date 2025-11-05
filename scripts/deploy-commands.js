import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = __filename.substring(0, __filename.lastIndexOf('\\') > -1
  ? __filename.lastIndexOf('\\')
  : __filename.lastIndexOf('/'));

async function loadAllCommands() {
  const commandsDir = join(__dirname, '../src/commands');
  const files = readdirSync(commandsDir).filter(f => f.endsWith('.js'));
  const commands = [];

  for (const file of files) {
    const filePath = join(commandsDir, file);
    const fileUrl = pathToFileURL(filePath).href;
    const mod = await import(fileUrl);
    // 各コマンドは { command: { data: SlashCommandBuilder, execute: fn } } を想定
    if (mod?.command?.data) {
      commands.push(mod.command.data.toJSON());
      console.log(`  - loaded: ${file}`);
    } else {
      console.warn(`  ! skipped (no export "command.data"): ${file}`);
    }
  }
  return commands;
}

async function main() {
  const appId = process.env.APPLICATION_ID;
  const guildId = process.env.GUILD_ID;
  const token = process.env.DISCORD_TOKEN;

  if (!appId || !guildId || !token) {
    console.error('❌ .env に APPLICATION_ID / GUILD_ID / DISCORD_TOKEN を設定してください');
    process.exit(1);
  }

  console.log('🛠  Guild コマンドをデプロイ中...');
  const commands = await loadAllCommands();

  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(
    Routes.applicationGuildCommands(appId, guildId),
    { body: commands },
  );

  console.log(`✅ デプロイ完了（${commands.length}件登録）`);
}

main().catch(err => {
  console.error('❌ デプロイ失敗:', err);
  process.exit(1);
});
