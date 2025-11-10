// src/commands/dice.js
import { SlashCommandBuilder } from 'discord.js';

export const command = {
  data: new SlashCommandBuilder()
    .setName('dice')
    .setDescription('ダイスを振ります（例: /dice 1d100）')
    .addStringOption(option =>
      option
        .setName('roll')
        .setDescription('XdY形式で指定 (例: 3d6, 1d100)')
        .setRequired(true)
    ),

  async execute(interaction) {
    const input = interaction.options.getString('roll')?.trim() ?? '';

    // パース
    const match = input.match(/^(\d*)d(\d+)$/i);
    if (!match) {
      return interaction.reply({
        content: '⚠️ 正しい形式で指定してください（例: `1d100`, `3d6`）',
        ephemeral: true
      });
    }

    const count = parseInt(match[1] || '1', 10);
    const sides = parseInt(match[2], 10);

    // 制限
    if (count < 1 || sides < 1) {
      return interaction.reply({ content: '⚠️ 数値は1以上を指定してください。', ephemeral: true });
    }
    if (count > 100) {
      return interaction.reply({ content: '⚠️ ダイスの個数は最大100個までです。', ephemeral: true });
    }
    if (sides > 1000) {
      return interaction.reply({ content: '⚠️ ダイスの面数は最大1000までです。', ephemeral: true });
    }

    // ダイスを振る
    const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
    const total = rolls.reduce((a, b) => a + b, 0);

    // 結果整形
    const result =
      count === 1
        ? `🎲 **${rolls[0]}** (1d${sides})`
        : `🎲 [${rolls.join(', ')}] → **合計: ${total}**`;

    await interaction.reply({ content: result });
  }
};
