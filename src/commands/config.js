// src/commands/config.js
import {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits
} from 'discord.js';

// storage は実行時にだけ import（デプロイ時にDB不要）
export const command = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('TRPGイベントの設定（管理者専用）')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand(sc =>
      sc
        .setName('setlogchannel')
        .setDescription('通知/ログチャンネルを設定または確認')
        .addChannelOption(o =>
          o.setName('channel')
            .setDescription('ログ出力先')
            .setRequired(false)
        )
    )
    .addSubcommand(sc =>
      sc
        .setName('setcategory')
        .setDescription('シナリオ用カテゴリを設定または確認')
        .addChannelOption(o =>
          o.setName('category')
            .setDescription('カテゴリチャンネル')
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(false)
        )
    )
    .addSubcommand(sc =>
      sc
        .setName('setboardchannel')
        .setDescription('予定一覧の掲示板チャンネルを設定または確認')
        .addChannelOption(o =>
          o.setName('channel')
            .setDescription('掲示板チャンネル')
            .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.GuildAnnouncement)
            .setRequired(false)
        )
    )
    .addSubcommand(sc =>
      sc
        .setName('reset')
        .setDescription('設定を初期化')
    ),

  async execute(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '⛔ 管理者のみ使用できます。', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    // ここでだけ storage を読み込む
    const { getGuildConfig, setGuildConfig, loadConfig, saveConfig } = await import('../utils/storage.js');

    if (sub === 'setlogchannel') {
      const ch = interaction.options.getChannel('channel');
      if (!ch) {
        const cur = getGuildConfig(interaction.guildId);
        return interaction.reply({ content: `現在のログチャンネル: ${cur?.logChannelId ? `<#${cur.logChannelId}>` : '未設定'}`, ephemeral: true });
      }
      if (!ch.isTextBased?.() && ch.type !== ChannelType.GuildText) {
        return interaction.reply({ content: '⛔ テキストチャンネルを指定してください。', ephemeral: true });
      }
      setGuildConfig(interaction.guildId, { logChannelId: ch.id });
      return interaction.reply({ content: `✅ ログチャンネルを <#${ch.id}> に設定しました。`, ephemeral: true });
    }

    if (sub === 'setcategory') {
      const cat = interaction.options.getChannel('category');
      if (!cat) {
        const cur = getGuildConfig(interaction.guildId);
        return interaction.reply({ content: `現在のシナリオ用カテゴリ: ${cur?.eventCategoryId ? `<#${cur.eventCategoryId}>` : '未設定'}`, ephemeral: true });
      }
      if (cat.type !== ChannelType.GuildCategory) {
        return interaction.reply({ content: '⛔ カテゴリチャンネルを指定してください。', ephemeral: true });
      }
      setGuildConfig(interaction.guildId, { eventCategoryId: cat.id });
      return interaction.reply({ content: `✅ シナリオ用カテゴリを **${cat.name}** に設定しました。`, ephemeral: true });
    }

    if (sub === 'setboardchannel') {
      const ch = interaction.options.getChannel('channel');
      const appCfg = loadConfig();
      appCfg[interaction.guildId] ??= {};
      appCfg[interaction.guildId].eventBoard ??= { channelId: null, messageId: null };

      if (!ch) {
        const cur = appCfg[interaction.guildId].eventBoard;
        return interaction.reply({ content: `現在の掲示板チャンネル: ${cur?.channelId ? `<#${cur.channelId}>` : '未設定'}\n（最新版のみ1メッセージを自動維持）`, ephemeral: true });
      }
      if (!ch.isTextBased?.()) {
        return interaction.reply({ content: '⛔ テキスト投稿可能なチャンネルを指定してください。', ephemeral: true });
      }

      // 切替時は旧掲示板メッセージを消す（あれば）
      if (appCfg[interaction.guildId].eventBoard.messageId && appCfg[interaction.guildId].eventBoard.channelId) {
        try {
          const oldCh = await interaction.client.channels.fetch(appCfg[interaction.guildId].eventBoard.channelId);
          const oldMsg = await oldCh?.messages?.fetch(appCfg[interaction.guildId].eventBoard.messageId);
          await oldMsg?.delete().catch(() => {});
        } catch {}
      }

      appCfg[interaction.guildId].eventBoard = { channelId: ch.id, messageId: null };
      saveConfig(appCfg);

      return interaction.reply({ content: `✅ 掲示板チャンネルを <#${ch.id}> に設定しました。`, ephemeral: true });
    }

    if (sub === 'reset') {
      setGuildConfig(interaction.guildId, { logChannelId: null, eventCategoryId: null });
      const appCfg = loadConfig();
      if (appCfg[interaction.guildId]?.eventBoard?.messageId && appCfg[interaction.guildId]?.eventBoard?.channelId) {
        try {
          const oldCh = await interaction.client.channels.fetch(appCfg[interaction.guildId].eventBoard.channelId);
          const oldMsg = await oldCh?.messages?.fetch(appCfg[interaction.guildId].eventBoard.messageId);
          await oldMsg?.delete().catch(() => {});
        } catch {}
      }
      appCfg[interaction.guildId] = {};
      saveConfig(appCfg);
      return interaction.reply({ content: '♻️ 設定を初期化しました。', ephemeral: true });
    }

    return interaction.reply({ content: '⛔ 未対応のサブコマンドです。', ephemeral: true });
  }
};
