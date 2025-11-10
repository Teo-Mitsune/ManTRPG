// src/commands/config.js
import {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits
} from 'discord.js';

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
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.PublicThread,
              ChannelType.PrivateThread,
              ChannelType.GuildAnnouncement
            )
            .setRequired(false)
        )
    )
    .addSubcommand(sc =>
      sc
        .setName('reset')
        .setDescription('設定を初期化')
    ),

  async execute(interaction) {
    // 権限チェック（先に弾く）
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '⛔ 管理者のみ使用できます。', ephemeral: true });
    }

    // 3秒制限回避のため、まずデファー
    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();

    // storage は「デファー後」に読み込み（遅延でも安全）
    const { getGuildConfig, setGuildConfig, loadConfig, saveConfig } =
      await import('../utils/storage.js');

    if (sub === 'setlogchannel') {
      const ch = interaction.options.getChannel('channel');
      if (!ch) {
        const cur = getGuildConfig(interaction.guildId);
        return interaction.editReply(
          `現在のログチャンネル: ${cur?.logChannelId ? `<#${cur.logChannelId}>` : '未設定'}`
        );
      }
      // テキスト投稿可であればOK（スレッド等も許容する場合は isTextBased を使う）
      if (!(ch.isTextBased?.() || ch.type === ChannelType.GuildText)) {
        return interaction.editReply('⛔ テキストチャンネルを指定してください。');
      }
      setGuildConfig(interaction.guildId, { logChannelId: ch.id });
      return interaction.editReply(`✅ ログチャンネルを <#${ch.id}> に設定しました。`);
    }

    if (sub === 'setcategory') {
      const cat = interaction.options.getChannel('category');
      if (!cat) {
        const cur = getGuildConfig(interaction.guildId);
        return interaction.editReply(
          `現在のシナリオ用カテゴリ: ${cur?.eventCategoryId ? `<#${cur.eventCategoryId}>` : '未設定'}`
        );
      }
      if (cat.type !== ChannelType.GuildCategory) {
        return interaction.editReply('⛔ カテゴリチャンネルを指定してください。');
      }
      setGuildConfig(interaction.guildId, { eventCategoryId: cat.id });
      return interaction.editReply(`✅ シナリオ用カテゴリを **${cat.name}** に設定しました。`);
    }

    if (sub === 'setboardchannel') {
      const ch = interaction.options.getChannel('channel');
      const appCfg = loadConfig();
      appCfg[interaction.guildId] ??= {};
      appCfg[interaction.guildId].eventBoard ??= { channelId: null, messageId: null };

      if (!ch) {
        const cur = appCfg[interaction.guildId].eventBoard;
        return interaction.editReply(
          `現在の掲示板チャンネル: ${cur?.channelId ? `<#${cur.channelId}>` : '未設定'}\n（最新版のみ1メッセージを自動維持）`
        );
      }
      if (!ch.isTextBased?.()) {
        return interaction.editReply('⛔ テキスト投稿可能なチャンネルを指定してください。');
      }

      // 旧掲示板メッセージ掃除（存在すれば）
      const prev = appCfg[interaction.guildId].eventBoard;
      if (prev?.messageId && prev?.channelId) {
        try {
          const oldCh = await interaction.client.channels.fetch(prev.channelId);
          const oldMsg = await oldCh?.messages?.fetch(prev.messageId);
          await oldMsg?.delete().catch(() => {});
        } catch {}
      }

      appCfg[interaction.guildId].eventBoard = { channelId: ch.id, messageId: null };
      saveConfig(appCfg);

      return interaction.editReply(`✅ 掲示板チャンネルを <#${ch.id}> に設定しました。`);
    }

    if (sub === 'reset') {
      setGuildConfig(interaction.guildId, { logChannelId: null, eventCategoryId: null });

      const appCfg = loadConfig();
      const prev = appCfg[interaction.guildId]?.eventBoard;
      if (prev?.messageId && prev?.channelId) {
        try {
          const oldCh = await interaction.client.channels.fetch(prev.channelId);
          const oldMsg = await oldCh?.messages?.fetch(prev.messageId);
          await oldMsg?.delete().catch(() => {});
        } catch {}
      }
      appCfg[interaction.guildId] = {};
      saveConfig(appCfg);

      return interaction.editReply('♻️ 設定を初期化しました。');
    }

    return interaction.editReply('⛔ 未対応のサブコマンドです。');
  }
};
