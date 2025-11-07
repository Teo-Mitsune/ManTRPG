// commands/eventadmin.js
import {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits
} from 'discord.js';

// utils/storage.js に setGuildConfig がある前提です。
// （もし無い場合は、そちらに setGuildConfig(guildId, partial) を追加してください）
import {
  getGuildConfig,
  setGuildConfig
} from '../utils/storage.js';

export const command = {
  data: new SlashCommandBuilder()
    .setName('eventadmin')
    .setDescription('TRPGイベント設定（管理）')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild) // ← 管理者限定
    .setDMPermission(false)
    .addSubcommand(sc =>
      sc
        .setName('config_setlogchannel')
        .setDescription('通知/ログを投下するチャンネルを設定（未指定で現在値を表示）')
        .addChannelOption(o =>
          o.setName('channel')
            .setDescription('ログ出力チャンネル')
            .setRequired(false)
        )
    )
    .addSubcommand(sc =>
      sc
        .setName('config_setcategory')
        .setDescription('シナリオ用プライベートchを作成するカテゴリを設定（未指定で現在値を表示）')
        .addChannelOption(o =>
          o.setName('category')
            .setDescription('カテゴリチャンネル')
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(false)
        )
    )
    .addSubcommand(sc =>
      sc
        .setName('config_reset')
        .setDescription('event の管理設定を初期化（確認ダイアログは出ません）')
    ),

  async execute(interaction) {
    // 二重ロック（既定権限＋実行時チェック）
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: '⛔ このコマンドは管理者のみ実行できます。',
        ephemeral: true
      });
    }

    const sub = interaction.options.getSubcommand();

    // 1) ログチャンネル設定/確認
    if (sub === 'config_setlogchannel') {
      const ch = interaction.options.getChannel('channel');
      if (!ch) {
        const cur = getGuildConfig(interaction.guildId);
        return interaction.reply({
          content: `現在のログチャンネル: ${cur?.logChannelId ? `<#${cur.logChannelId}>` : '未設定'}`,
          ephemeral: true
        });
      }
      // テキスト系かどうか軽く確認（Category/VC禁止まではしない）
      if (!ch.isTextBased?.() && ch.type !== ChannelType.GuildText) {
        return interaction.reply({ content: '⛔ テキストチャンネルを指定してください。', ephemeral: true });
      }

      const next = setGuildConfig(interaction.guildId, { logChannelId: ch.id });
      return interaction.reply({
        content: `✅ ログチャンネルを <#${ch.id}> に設定しました。`,
        ephemeral: true
      });
    }

    // 2) カテゴリ設定/確認
    if (sub === 'config_setcategory') {
      const cat = interaction.options.getChannel('category');
      if (!cat) {
        const cur = getGuildConfig(interaction.guildId);
        return interaction.reply({
          content: `現在のシナリオ用カテゴリ: ${cur?.eventCategoryId ? `<#${cur.eventCategoryId}>` : '未設定'}`,
          ephemeral: true
        });
      }
      if (cat.type !== ChannelType.GuildCategory) {
        return interaction.reply({ content: '⛔ カテゴリチャンネルを指定してください。', ephemeral: true });
      }

      const next = setGuildConfig(interaction.guildId, { eventCategoryId: cat.id });
      return interaction.reply({
        content: `✅ シナリオ用カテゴリを **${cat.name}** に設定しました。`,
        ephemeral: true
      });
    }

    // 3) リセット
    if (sub === 'config_reset') {
      const next = setGuildConfig(interaction.guildId, { logChannelId: null, eventCategoryId: null });
      return interaction.reply({
        content: '♻️ 設定を初期化しました。（ログチャンネル/カテゴリともに未設定）',
        ephemeral: true
      });
    }

    // 想定外
    return interaction.reply({ content: '⛔ 未対応のサブコマンドです。', ephemeral: true });
  }
};
