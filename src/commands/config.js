// src/commands/config.js
import {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits
} from 'discord.js';
import { getGuildConfig, setGuildConfig } from '../utils/storage.js';

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
        .setName('reset')
        .setDescription('設定を初期化')
    ),

  async execute(interaction) {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: '⛔ 管理者のみ使用できます。',
        ephemeral: true
      });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'setlogchannel') {
      const ch = interaction.options.getChannel('channel');
      if (!ch) {
        const cur = getGuildConfig(interaction.guildId);
        return interaction.reply({
          content: `現在のログチャンネル: ${cur?.logChannelId ? `<#${cur.logChannelId}>` : '未設定'}`,
          ephemeral: true
        });
      }
      if (!ch.isTextBased?.() && ch.type !== ChannelType.GuildText) {
        return interaction.reply({ content: '⛔ テキストチャンネルを指定してください。', ephemeral: true });
      }
      setGuildConfig(interaction.guildId, { logChannelId: ch.id });
      return interaction.reply({
        content: `✅ ログチャンネルを <#${ch.id}> に設定しました。`,
        ephemeral: true
      });
    }

    if (sub === 'setcategory') {
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
      setGuildConfig(interaction.guildId, { eventCategoryId: cat.id });
      return interaction.reply({
        content: `✅ シナリオ用カテゴリを **${cat.name}** に設定しました。`,
        ephemeral: true
      });
    }

    if (sub === 'reset') {
      setGuildConfig(interaction.guildId, { logChannelId: null, eventCategoryId: null });
      return interaction.reply({
        content: '♻️ 設定を初期化しました。',
        ephemeral: true
      });
    }
  }
};
