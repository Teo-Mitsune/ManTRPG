// src/commands/deal.js
import { SlashCommandBuilder } from 'discord.js';

export const command = {
  data: new SlashCommandBuilder()
    .setName('deal')
    .setDescription('アイテム配布 or ワードウルフ配布（完全非公開）')

    // 配布先ユーザー
    .addUserOption(opt => opt.setName('user1').setDescription('配布先 1人目').setRequired(true))
    .addUserOption(opt => opt.setName('user2').setDescription('配布先 2人目').setRequired(false))
    .addUserOption(opt => opt.setName('user3').setDescription('配布先 3人目').setRequired(false))
    .addUserOption(opt => opt.setName('user4').setDescription('配布先 4人目').setRequired(false))
    .addUserOption(opt => opt.setName('user5').setDescription('配布先 5人目').setRequired(false))

    // 通常配布用
    .addStringOption(opt =>
      opt.setName('items').setDescription('配布するアイテム（カンマ区切り）').setRequired(false)
    )

    // ワードウルフ用
    .addBooleanOption(opt =>
      opt.setName('wordwolf').setDescription('ワードウルフモードをONにする').setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('text1').setDescription('ワードウルフ用 テキスト1').setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('text2').setDescription('ワードウルフ用 テキスト2').setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    // ユーザー収集
    const users = [
      interaction.options.getUser('user1'),
      interaction.options.getUser('user2'),
      interaction.options.getUser('user3'),
      interaction.options.getUser('user4'),
      interaction.options.getUser('user5'),
    ].filter(Boolean);

    const isWordWolf = interaction.options.getBoolean('wordwolf') ?? false;

    // -----------------------------
    // 🐺 ワードウルフモード
    // -----------------------------
    if (isWordWolf) {
      const text1 = interaction.options.getString('text1');
      const text2 = interaction.options.getString('text2');

      if (!text1 || !text2) {
        await interaction.editReply('⛔ ワードウルフモードでは text1 と text2 の両方が必要です。');
        return;
      }

      const total = users.length;

      // ✅ 少数派人数ルール（要望どおり）
      const minorityCount = total >= 5 ? 2 : 1;

      // ✅ どちらが少数派かランダム
      const minorityText = Math.random() < 0.5 ? text1 : text2;
      const majorityText = minorityText === text1 ? text2 : text1;

      // ✅ ユーザーシャッフル
      const shuffled = [...users].sort(() => Math.random() - 0.5);

      const minorityUsers = shuffled.slice(0, minorityCount);
      const majorityUsers = shuffled.slice(minorityCount);

      // ✅ DM送信
      let successCount = 0;

      for (const user of minorityUsers) {
        try {
          await user.send({
            content: [
              '**ワードウルフ：あなたに単語をプレゼント**',
              '',
              `【あなたのワード】${minorityText}`
            ].join('\n')
          });
          successCount++;
        } catch {}
      }

      for (const user of majorityUsers) {
        try {
          await user.send({
            content: [
              ' **ワードウルフ：あなたに単語をプレゼント**',
              '',
              `【あなたのワード】${majorityText}`
            ].join('\n')
          });
          successCount++;
        } catch {}
      }

      // ✅ 配布者には「結果の事実だけ」
      await interaction.editReply({
        content: [
          '✅ **ワードウルフ配布が完了しました（完全非公開）**',
          '',
          `👥 参加人数: ${total}人`,
          `🐺 少数派: ${minorityCount}人`,
          `📮 DM送信成功: ${successCount}人`,
          '',
          '※誰が少数派か、どのワードが少数派かは**配布者にも表示されません**。'
        ].join('\n')
      });
      return;
    }

    // -----------------------------
    // 🎁 通常アイテム配布モード
    // -----------------------------
    const rawItems = interaction.options.getString('items');
    if (!rawItems) {
      await interaction.editReply('⛔ 通常配布では items が必須です。');
      return;
    }

    const items = rawItems.split(',').map(s => s.trim()).filter(Boolean);

    if (users.length > items.length) {
      await interaction.editReply(
        `⛔ 配布人数（${users.length}人）に対して、アイテム数（${items.length}個）が足りません。`
      );
      return;
    }

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
      } catch {}
    }

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
