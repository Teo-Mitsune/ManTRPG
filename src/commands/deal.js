// src/commands/deal.js
import { SlashCommandBuilder } from 'discord.js';

export const command = {
  data: new SlashCommandBuilder()
    .setName('deal')
    .setDescription('アイテムを複数人に“完全に秘密裏”で配布します（配布者も中身は見えません）')
    .addUserOption(opt =>
      opt.setName('user1').setDescription('配布先 1人目').setRequired(true)
    )
    .addUserOption(opt =>
      opt.setName('user2').setDescription('配布先 2人目').setRequired(false)
    )
    .addUserOption(opt =>
      opt.setName('user3').setDescription('配布先 3人目').setRequired(false)
    )
    .addUserOption(opt =>
      opt.setName('user4').setDescription('配布先 4人目').setRequired(false)
    )
    .addUserOption(opt =>
      opt.setName('user5').setDescription('配布先 5人目').setRequired(false)
    )
    .addStringOption(opt =>
      opt
        .setName('items')
        .setDescription('配布するアイテム（カンマ区切り）')
        .setRequired(true)
    ),

  async execute(interaction) {
    // ✅ 「アプリケーションが応答しません」完全防止
    await interaction.deferReply({ ephemeral: true });

    // 配布先ユーザー一覧
    const users = [
      interaction.options.getUser('user1'),
      interaction.options.getUser('user2'),
      interaction.options.getUser('user3'),
      interaction.options.getUser('user4'),
      interaction.options.getUser('user5'),
    ].filter(Boolean);

    // アイテム一覧（順番対応）
    const rawItems = interaction.options.getString('items');
    const items = rawItems.split(',').map(s => s.trim()).filter(Boolean);

    if (items.length === 0) {
      await interaction.editReply('⛔ アイテムが1つも指定されていません。');
      return;
    }

    if (users.length > items.length) {
      await interaction.editReply(
        `⛔ 配布人数（${users.length}人）に対して、アイテム数（${items.length}個）が足りません。`
      );
      return;
    }

    // ✅ 完全秘匿DM配布（誰にも内容は漏れない）
    let successCount = 0;

    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const item = items[i];

      try {
        await user.send({
          content: [
            '🎁 **あなたにアイテムが配布されました**',
            '',
            `【あなたのアイテム】${item}`
          ].join('\n')
        });
        successCount++;
      } catch {
        // DM失敗はカウントしないが、配布者にも詳細は見せない
      }
    }

    // ✅ 配布者には「完了した事実だけ」を通知（中身は完全に伏せる）
    await interaction.editReply({
      content: [
        '✅ **アイテム配布が完了しました**',
        '',
        `📦 配布人数: ${users.length}人`,
        `📮 DM送信成功: ${successCount}人`,
        '',
        '※配布内容は **受け取った人だけ** が確認できます。'
      ].join('\n')
    });
  }
};
