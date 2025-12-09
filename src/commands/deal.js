import { SlashCommandBuilder } from 'discord.js';

export const command = {
  data: new SlashCommandBuilder()
    .setName('deal')
    .setDescription('指定したアイテムをユーザーにランダム配布します')
    .addStringOption(opt =>
      opt.setName('items')
        .setDescription('例: a,b,c,d,e')
        .setRequired(true)
    )
    .addUserOption(opt =>
      opt.setName('user1').setDescription('1人目').setRequired(true)
    )
    .addUserOption(opt =>
      opt.setName('user2').setDescription('2人目').setRequired(true)
    )
    .addUserOption(opt =>
      opt.setName('user3').setDescription('3人目').setRequired(true)
    )
    .addUserOption(opt =>
      opt.setName('user4').setDescription('4人目').setRequired(false)
    )
    .addUserOption(opt =>
      opt.setName('user5').setDescription('5人目').setRequired(false)
    ),

  async execute(interaction) {
    const items = interaction.options.getString('items')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const users = [
      interaction.options.getUser('user1'),
      interaction.options.getUser('user2'),
      interaction.options.getUser('user3'),
      interaction.options.getUser('user4'),
      interaction.options.getUser('user5'),
    ].filter(Boolean);

    if (items.length !== users.length) {
      return interaction.reply({
        content: `⛔ アイテム数(${items.length})とユーザー数(${users.length})が一致しません。`,
        ephemeral: true
      });
    }

    // ---- シャッフル ----
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }

    const resultText = users
      .map((u, i) => `${u} → **${items[i]}**`)
      .join('\n');

    // 👥 公開メッセージ（みんなが見る）
    await interaction.channel.send({
      content: `🎲 **ランダム配布結果**\n${resultText}`
    });

    // 👤 実行者にだけ成功を通知
    await interaction.reply({
      content: `✅ 配布が完了しました！結果はこのチャンネルに送信済みです。`,
      ephemeral: true
    });
  }
};
