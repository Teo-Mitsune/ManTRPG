require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const {
  DISCORD_TOKEN: token,
  APPLICATION_ID: applicationId,
  GUILD_ID: guildId
} = process.env;

if (!token || !applicationId || !guildId) {
  console.error('Missing env. Please set DISCORD_TOKEN, APPLICATION_ID, GUILD_ID');
  process.exit(1);
}

/**
 * 公開コマンド: /event
 * - @everyone が使える
 */
const eventCmd = new SlashCommandBuilder()
  .setName('event')
  .setDescription('TRPGイベント募集/管理（公開）')
  .setDefaultMemberPermissions(0)     // ← 全員OKに固定
  .setDMPermission(false)
  .addSubcommand(sc => sc
    .setName('ui')
    .setDescription('募集UIを作成/表示します')
    .addStringOption(o => o.setName('title').setDescription('タイトル').setRequired(true))
    .addStringOption(o => o.setName('system').setDescription('システム例: CoC, D&D').setRequired(true))
    .addStringOption(o => o.setName('date').setDescription('日時（例: 2025-11-08 21:00）').setRequired(true))
    .addIntegerOption(o => o.setName('max').setDescription('最大参加人数（0で無制限）').setRequired(true))
    .addStringOption(o => o.setName('tags').setDescription('タグ（任意）'))
    .addStringOption(o => o.setName('desc').setDescription('説明（任意）'))
  );

/**
 * 管理コマンド: /eventadmin
 * - ManageGuild 以上のみ
 * - ここに "config_*" を集約
 */
const eventAdminCmd = new SlashCommandBuilder()
  .setName('eventadmin')
  .setDescription('TRPGイベント設定（管理）')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild) // ← 管理限定
  .setDMPermission(false)
  .addSubcommand(sc => sc
    .setName('config_channel')
    .setDescription('募集を既定で投下するチャンネルを設定/確認')
    .addChannelOption(o => o.setName('channel').setDescription('設定するチャンネル（省略で確認）').setRequired(false)))
  .addSubcommand(sc => sc
    .setName('config_role')
    .setDescription('募集時にメンションするロールを設定/確認')
    .addRoleOption(o => o.setName('role').setDescription('設定するロール（省略で確認）').setRequired(false)))
  .addSubcommand(sc => sc
    .setName('config_reset')
    .setDescription('event の管理設定を初期化（確認ダイアログは出ません）')
  );

/** 既存: /calendar export などがあるなら一緒に登録（必要に応じて残す） */
const calendarCmd = new SlashCommandBuilder()
  .setName('calendar')
  .setDescription('セッション予定のカレンダー操作')
  .setDefaultMemberPermissions(0)
  .setDMPermission(false)
  .addSubcommand(sc => sc.setName('export').setDescription('このサーバの全セッションを .ics として出力'));

const commands = [eventCmd.toJSON(), eventAdminCmd.toJSON(), calendarCmd.toJSON()];

(async () => {
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    console.log('Registering commands (guild)…');
    await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: commands });
    console.log('Done.');
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
