// scripts/deploy-commands.js
import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { readdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'dummy-for-command-deploy';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('❌ DISCORD_TOKEN または DISCORD_CLIENT_ID が .env に設定されていません。');
  process.exit(1);
}

const commandsDir = join(__dirname, '..', 'src', 'commands');
const commandFiles = readdirSync(commandsDir).filter(f => f.endsWith('.js'));

const commands = [];
for (const file of commandFiles) {
  const fileUrl = pathToFileURL(join(commandsDir, file)).href;
  const { command } = await import(fileUrl);
  if (!command?.data?.toJSON) {
    console.warn(`⚠️ スキップ: ${file} は { command: { data, execute } } 形式ではありません。`);
    continue;
  }
  commands.push(command.data.toJSON());
}

console.log(`📝 登録対象コマンド: ${commands.map(c => c.name).join(', ') || '(なし)'}`);

const rest = new REST({ version: '10' }).setToken(TOKEN);

try {
  if (GUILD_ID) {
    const data = await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log(`✅ ギルド(${GUILD_ID}) に ${data.length} 件を登録しました。`);
  } else {
    const data = await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands }
    );
    console.log(`✅ グローバルに ${data.length} 件を登録しました。`);
    console.log('⏳ 反映には数分かかることがあります。');
  }
} catch (err) {
  console.error('❌ 登録エラー:', err);
  process.exit(1);
}
