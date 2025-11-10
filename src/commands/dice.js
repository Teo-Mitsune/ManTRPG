// commands/dice.js
import { SlashCommandBuilder } from 'discord.js';

function parseDice(expr) {
  // 例: 1d100, 3d6+2, 2d8-1
  const m = expr.toLowerCase().replace(/\s+/g, '').match(/^(\d{1,3})d(\d{1,5})(?:([+-])(\d{1,6}))?$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const sides = parseInt(m[2], 10);
  const mod = m[3] ? (m[3] === '-' ? -parseInt(m[4], 10) : parseInt(m[4], 10)) : 0;
  return { n, sides, mod };
}

function rollOnce(sides) {
  // 1..sides の整数
  return 1 + Math.floor(Math.random() * sides);
}

export const command = {
  data: new SlashCommandBuilder()
    .setName('dice')
    .setDescription('ダイスを振ります（例: 1d100, 3d6+2）')
    .addStringOption(opt =>
      opt
        .setName('expr')
        .setDescription('式: NdM または NdM±K（例: 1d100, 3d6+2）')
        .setRequired(true)
    ),

  async execute(interaction) {
    const exprRaw = interaction.options.getString('expr');
    const parsed = parseDice(exprRaw);

    if (!parsed) {
      await interaction.reply({ content: '⛔ 式が不正です。例: `1d100`, `3d6+2`（NdM±K）', ephemeral: true });
      return;
    }

    const { n, sides, mod } = parsed;

    // 乱用防止のための上限
    if (n < 1 || n > 100 || sides < 2 || sides > 100000) {
      await interaction.reply({
        content: '⛔ 範囲外です。ダイス個数は 1〜100、面数は 2〜100000 を指定してください。',
        ephemeral: true
      });
      return;
    }

    // ロール
    const rolls = Array.from({ length: n }, () => rollOnce(sides));
    const sum = rolls.reduce((a, b) => a + b, 0);
    const total = sum + mod;

    // 出力整形
    let msg = `🎲 ${interaction.user} → \`${exprRaw}\`\n`;
    if (n === 1 && mod === 0) {
      msg += `結果: **${rolls[0]}**`;
    } else {
      msg += `出目: [${rolls.join(', ')}]`;
      if (mod !== 0) msg += ` ${mod > 0 ? `+ ${mod}` : `- ${Math.abs(mod)}`}`;
      msg += `\n合計: **${total}**`;
    }

    await interaction.reply({ content: msg });
  },
};
