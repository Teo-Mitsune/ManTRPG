import { SlashCommandBuilder, ChannelType, PermissionFlagsBits } from 'discord.js';
import { getGuildConfig, setGuildConfig } from '../utils/storage.js';

export const command = {
  data: new SlashCommandBuilder()
    .setName('event')
    .setDescription('予定のGUI操作パネル / 設定')
    .setDefaultMemberPermissions(null) // 誰でも /event ui は見える。設定は実行時に権限チェック
    .addSubcommand(sc =>
      sc.setName('ui')
        .setDescription('GUIパネルを開く（ボタン/フォームで操作）')
    )
    .addSubcommand(sc =>
      sc.setName('config_setlogchannel')
        .setDescription('予定管理チャンネルを設定（通知・変更ログの投稿先）')
        .addChannelOption(o => o
          .setName('channel')
          .setDescription('予定管理チャンネル')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true))
    )
    .addSubcommand(sc =>
      sc.setName('config_setcategory')
        .setDescription('シナリオ用のプライベートチャンネルを作るカテゴリを設定')
        .addChannelOption(o => o
          .setName('category')
          .setDescription('カテゴリ（Category）')
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(true))
    )
    .addSubcommand(sc =>
      sc.setName('config_show')
        .setDescription('現在の設定を表示')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'ui') {
      // UI 自体は index.js 側で処理（即時返信）。ここでは何もしない（保険）。
      return interaction.reply({ content: '📋 **予定パネル**は、このサーバで有効です。`/event ui` はエフェメラル表示されます。', ephemeral: true });
    }

    // 設定サブコマンドは管理権限チェック（Manage Guild 相当）
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const isAdminLike =
      member.permissions.has(PermissionFlagsBits.ManageGuild) ||
      member.permissions.has(PermissionFlagsBits.Administrator);

    if (!isAdminLike) {
      // ここで即時ACK（3秒対策）
      await interaction.reply({ content: '⛔ この操作は管理者のみ可能です。', ephemeral: true });
      return;
    }

    // 以降は重め処理の恐れがあるので defer
    await interaction.deferReply({ ephemeral: true });

    if (sub === 'config_setlogchannel') {
      const ch = interaction.options.getChannel('channel', true);
      const next = setGuildConfig(interaction.guildId, { logChannelId: ch.id });
      await interaction.editReply({
        content: [
          '✅ 予定管理チャンネルを設定しました。',
          `・logChannelId: <#${next.logChannelId}>`,
          `・eventCategoryId: ${next.eventCategoryId ? `<#${next.eventCategoryId}>` : '未設定'}`
        ].join('\n')
      });
      return;
    }

    if (sub === 'config_setcategory') {
      const cat = interaction.options.getChannel('category', true);
      const next = setGuildConfig(interaction.guildId, { eventCategoryId: cat.id });
      await interaction.editReply({
        content: [
          '✅ シナリオ用カテゴリを設定しました。',
          `・logChannelId: ${next.logChannelId ? `<#${next.logChannelId}>` : '未設定'}`,
          `・eventCategoryId: <#${next.eventCategoryId}>`
        ].join('\n')
      });
      return;
    }

    if (sub === 'config_show') {
      const cfg = getGuildConfig(interaction.guildId);
      await interaction.editReply({
        content: [
          '🧩 現在の設定',
          `・logChannelId: ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : '未設定'}`,
          `・eventCategoryId: ${cfg.eventCategoryId ? `<#${cfg.eventCategoryId}>` : '未設定'}`
        ].join('\n')
      });
      return;
    }
  }
};
