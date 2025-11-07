// src/commands/ui.js
import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';

export const command = {
  data: new SlashCommandBuilder()
    .setName('ui')
    .setDescription('TRPGセッション募集・参加UIを開く')
    .setDefaultMemberPermissions(0)
    .setDMPermission(false),

  async execute(interaction) {
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('evui_add').setLabel('予定を追加').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('evui_list').setLabel('予定一覧').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('evui_edit').setLabel('予定を編集').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('evui_remove').setLabel('予定を削除').setStyle(ButtonStyle.Danger),
    );

    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('evui_join').setLabel('参加する').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('evui_unjoin').setLabel('参加取消').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('evui_viewmembers').setLabel('参加者を見る').setStyle(ButtonStyle.Secondary),
    );

    await interaction.reply({
      content: '📋 **予定パネル**',
      components: [row1, row2],
      ephemeral: true
    });
  }
};
