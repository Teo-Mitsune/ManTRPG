// commands/ui.js
import { SlashCommandBuilder } from 'discord.js';

export const command = {
  data: new SlashCommandBuilder()
    .setName('ui')
    .setDescription('TRPGセッション募集・参加UIを開く')
    .setDefaultMemberPermissions(0)   // 全員OK
    .setDMPermission(false),

  async execute(interaction) {
    // index.js 側で /ui をハンドリングするよう変更してください
    await interaction.reply({
      content: '📋 予定パネルを開きます…',
      ephemeral: true
    });
  }
};
