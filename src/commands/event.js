// commands/event.js
import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

export const command = {
  data: new SlashCommandBuilder()
    .setName('event')
    .setDescription('TRPGイベント募集/管理（公開）')
    .setDefaultMemberPermissions(0)        // ← @everyone が使える
    .setDMPermission(false)                // ← ギルド内のみ
    .addSubcommand(sc =>
      sc
        .setName('ui')
        .setDescription('募集UIを表示/作成します')
    ),
  /**
   * /event ui は index.js 側でハンドリングしています。
   * 念のためここでもフォールバックを用意しておきます。
   */
  async execute(interaction) {
    const sub = interaction.options.getSubcommand(false);

    if (sub === 'ui') {
      // 通常は index.js の特別処理が走るためここに来ない想定
      return interaction.reply({
        content: '📋 予定パネルを開きます…（もし表示されない場合は、Botのメッセージ送信権限をご確認ください）',
        ephemeral: true
      });
    }

    // それ以外はヘルプ表示
    return interaction.reply({
      content: '利用可能: `/event ui` — 予定の追加/編集/参加を行うUIを開きます。',
      ephemeral: true
    });
  }
};
