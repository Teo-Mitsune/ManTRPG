// src/commands/dice.js
import { SlashCommandBuilder } from 'discord.js';

export const command = {
  data: new SlashCommandBuilder()
    .setName('dice')
    .setDescription('ダイスを振ります（例: /dice 3d6+2）')
    .addStringOption(option =>
      option
        .setName('roll')
        .setDescription('XdY+Z形式で指定（例: 3d6+2, 1d100。未指定時は1d100）')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    try {
      const inputRaw = interaction.options.getString('roll');
      const input = (inputRaw?.trim() || '1d100').toLowerCase();

      // XdY+Z（修飾子ありも許可）
      const m = input.match(/^(\d*)d(\d+)([+-]\d+)?$/i);
      if (!m) {
        return interaction.editReply('⚠️ 正しい形式で指定してください（例: `1d100`, `3d6+2`, `2d10-1`）');
      }

      const count = parseInt(m[1] || '1', 10);
      const sides = parseInt(m[2], 10);
      const modifier = parseInt(m[3] || '0', 10);

      // 制限
      if (count < 1 || sides < 1) {
        return interaction.editReply('⚠️ 数値は1以上を指定してください。');
      }
      if (count > 100) {
        return interaction.editReply('⚠️ ダイスの個数は最大100個までです。');
      }
      if (sides > 1000) {
        return interaction.editReply('⚠️ ダイスの面数は最大1000までです。');
      }

      // 振る
      const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
      const sum = rolls.reduce((a, b) => a + b, 0);
      const total = sum + modifier;

      // 出力
      const display =
        modifier !== 0
          ? `🎲 <@${interaction.user.id}> → ${count}d${sides}${modifier >= 0 ? `+${modifier}` : modifier}\n出目: [${rolls.join(', ')}] ${modifier >= 0 ? `+ ${modifier}` : `- ${Math.abs(modifier)}`}\n合計: **${total}**`
          : `🎲 <@${interaction.user.id}> → ${count}d${sides}\n出目: [${rolls.join(', ')}]\n合計: **${total}**`;

      await interaction.editReply(display);
    } catch (err) {
      console.error('[dice]', err);
      await interaction.editReply('⚠️ ダイス処理中にエラーが発生しました。');
    }
  }
};
