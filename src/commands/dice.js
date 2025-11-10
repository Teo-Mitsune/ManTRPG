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
    try {
      const inputRaw = interaction.options.getString('roll');
      const input = (inputRaw?.trim() || '1d100').toLowerCase();

      // 形式: XdY(+/-Z)
      const m = input.match(/^(\d*)d(\d+)([+-]\d+)?$/i);
      if (!m) {
        await interaction.reply({
          content: '⚠️ 正しい形式で指定してください（例: `1d100`, `3d6+2`, `2d10-1`）',
          ephemeral: true
        });
        return;
      }

      const count = parseInt(m[1] || '1', 10);
      const sides = parseInt(m[2], 10);
      const modifier = parseInt(m[3] || '0', 10);

      // 制限
      if (count < 1 || sides < 1) {
        await interaction.reply({ content: '⚠️ 数値は1以上を指定してください。', ephemeral: true });
        return;
      }
      if (count > 100) {
        await interaction.reply({ content: '⚠️ ダイスの個数は最大100個までです。', ephemeral: true });
        return;
      }
      if (sides > 1000) {
        await interaction.reply({ content: '⚠️ ダイスの面数は最大1000までです。', ephemeral: true });
        return;
      }

      // ロール
      const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
      const sum = rolls.reduce((a, b) => a + b, 0);
      const total = sum + modifier;

      // 表示名（メンションはしない）
      const who = interaction.member?.displayName ?? interaction.user.username;

      // 出力整形
      const expr = `${count}d${sides}${modifier ? (modifier > 0 ? `+${modifier}` : `${modifier}`) : ''}`;
      const modText = modifier ? (modifier > 0 ? ` + ${modifier}` : ` - ${Math.abs(modifier)}`) : '';
      const display =
        `🎲 @${who} → ${expr}\n` +
        `出目: [${rolls.join(', ')}]${modText}\n` +
        `合計: **${total}**`;

      // 即時返信（deferReplyは使わない）
      await interaction.reply(display);
    } catch (err) {
      console.error('[dice]', err);
      // まだ未返信なら reply、既に返信済みなら followUp
      try {
        await interaction.reply('⚠️ ダイス処理中にエラーが発生しました。');
      } catch {
        await interaction.followUp('⚠️ ダイス処理中にエラーが発生しました。');
      }
    }
  }
};
