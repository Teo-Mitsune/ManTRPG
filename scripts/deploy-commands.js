// scripts/deploy-commands.js
import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { readdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---- 環境変数 ----
const TOKEN =
  process.env.DISCORD_TOKEN ||
  process.env.BOT_TOKEN;
const CLIENT_ID =
  process.env.DISCORD_CLIENT_ID ||
  process.env.APPLICATION_ID ||
  process.env.CLIENT_ID;
const GUILD_ID =
  process.env.DISCORD_GUILD_ID ||
  process.env.GUILD_ID;

if (!TOKEN) {
  console.error('❌ DISCORD_TOKEN (BOT トークン) が .env に設定されていません。');
  process.exit(1);
}
if (!CLIENT_ID) {
  console.error('❌ DISCORD_CLIENT_ID / APPLICATION_ID / CLIENT_ID のいずれも設定されていません。');
  process.exit(1);
}
if (!GUILD_ID) {
  console.error('❌ DISCORD_GUILD_ID / GUILD_ID のいずれも設定されていません。');
  process.exit(1);
}

// ---- commands ディレクトリの探索 ----
const commandDirCandidates = [
  join(__dirname, '..', 'src', 'commands'), // /workspace/src/commands
  join(__dirname, '..', 'commands'),        // /workspace/commands
];

const commandsPath = commandDirCandidates.find(p => existsSync(p));
if (!commandsPath) {
  console.error('❌ commands ディレクトリが見つかりません。試行したパス:');
  for (const p of commandDirCandidates) console.error(' -', p);
  process.exit(1);
}

console.log('📂 commands ディレクトリ:', commandsPath);

// ---- Slash コマンド定義を読み込み ----
const commands = [];

const files = readdirSync(commandsPath).filter(f => f.endsWith('.js'));
if (files.length === 0) {
  console.warn('⚠️ .js コマンドファイルが 0 件です。何も登録されません。');
}

for (const file of files) {
  const fileUrl = pathToFileURL(join(commandsPath, file)).href;
  console.log('  ↳ 読み込み中:', file);

  const imported = await import(fileUrl).catch((e) => {
    console.error('  ❌ import 失敗:', file, e);
    return null;
  });
  if (!imported) continue;

  const command = imported.command ?? imported.default;
  if (!command?.data?.toJSON) {
    console.warn('  ⚠️ command.data.toJSON がありません。スキップ:', file);
    continue;
  }

  commands.push(command.data.toJSON());
}

console.log(`✅ 読み込んだコマンド数: ${commands.length}`);

// ---- Discord へ登録 ----
const rest = new REST({ version: '10' }).setToken(TOKEN);

try {
  console.log(
    `🚀 Discord へ Slash コマンドをデプロイします (guild: ${GUILD_ID})...`
  );

  const data = await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands },
  );

  console.log(`🎉 完了: ${Array.isArray(data) ? data.length : 0} 件のコマンドを登録しました。`);
} catch (error) {
  console.error('❌ デプロイ中にエラーが発生しました:', error);
  process.exit(1);
}
