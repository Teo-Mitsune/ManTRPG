import {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import { setGuildConfig, getGuildConfig } from '../utils/storage.js';

export const command = {
  data: new SlashCommandBuilder()
    .setName('event')
    .setDescription('予定管理コマンド')
    // GUI 起動（処理は index.js 側でフック）
    .addSubcommand(sc =>
      sc
        .setName('ui')
        .setDescription('予定管理のGUIパネルを開く（エフェメラル表示）')
    )
    // 予定ログを投下するチャンネルを設定
    .addSubcommand(sc =>
      sc
        .setName('config_setlogchannel')
        .setDescription('予定管理チャンネル（通知先）を設定します')
        .addChannelOption(o =>
          o
            .setName('channel')
            .setDescription('予定ログを投下するチャンネル')
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement
            )
            .setRequired(true)
        )
    )
    // シナリオ用のカテゴリを設定（ここにシナリオごとのプライベートchを自動作成）
    .addSubcommand(sc =>
      sc
        .setName('config_setcategory')
        .setDescription('シナリオ用カテゴリを設定します（予定作成時にプライベートchを自動生成）')
        .addChannelOption(o =>
          o
            .setName('category')
            .setDescription('カテゴリチャンネル（GuildCategory）')
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true)
        )
    )
    // 現在の設定を確認
    .addSubcommand(sc =>
      sc
        .setName('config_show')
        .setDescription('現在の予定管理の設定を表示します')
    )
    // 基本的には管理側のみ
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setDMPermission(false),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'config_setlogchannel') {
      const ch = interaction.options.getChannel('channel', true);
      const cfg = setGuildConfig(interaction.guildId, { logChannelId: ch.id });
      await interaction.reply({
        content: `✅ 予定管理チャンネルを <#${cfg.logChannelId}> に設定しました。`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'config_setcategory') {
      const category = interaction.options.getChannel('category', true);
      const cfg = setGuildConfig(interaction.guildId, { eventCategoryId: category.id });
      await interaction.reply({
        content: `✅ シナリオ用カテゴリを **${category.name}** に設定しました。`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'config_show') {
      const cfg = getGuildConfig(interaction.guildId) ?? {};
      const lines = [
        `• 予定管理チャンネル: ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : '未設定'}`,
        `• シナリオ用カテゴリ: ${cfg.eventCategoryId ? `<#${cfg.eventCategoryId}>` : '未設定'}`,
      ];
      await interaction.reply({ content: `📋 現在の設定\n${lines.join('\n')}`, ephemeral: true });
      return;
    }

    // 'ui' は index.js 側で処理するためここでは案内のみ
    await interaction.reply({
      content: 'ℹ️ GUIはこの後にエフェメラルで表示されます。',
      ephemeral: true,
    });
  },
};
