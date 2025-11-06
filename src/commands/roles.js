import {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle
} from 'discord.js';
import { loadConfig, saveConfig, ensureRolesPanelConfig } from '../utils/storage.js';

export const command = {
  data: new SlashCommandBuilder()
    .setName('roles')
    .setDescription('ロール配布パネルの管理')
    .addSubcommand(sc =>
      sc.setName('setup')
        .setDescription('ロール配布パネルを投稿/更新する（チャンネル未指定なら現在のチャンネル）')
        .addChannelOption(o => o
          .setName('channel')
          .setDescription('投稿先チャンネル')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false)))
    .addSubcommand(sc =>
      sc.setName('add')
        .setDescription('配布対象のロールを追加')
        .addRoleOption(o => o.setName('role').setDescription('付与/剥奪するロール').setRequired(true))
        .addStringOption(o => o.setName('label').setDescription('ボタン表示名').setRequired(false))
        .addStringOption(o => o.setName('emoji').setDescription('ボタン絵文字（任意）').setRequired(false)))
    .addSubcommand(sc =>
      sc.setName('remove')
        .setDescription('配布対象のロールを削除')
        .addRoleOption(o => o.setName('role').setDescription('削除するロール').setRequired(true)))
    .addSubcommand(sc =>
      sc.setName('list')
        .setDescription('現在の配布対象ロールを表示')),
  async execute(interaction) {
    // 権限チェック（サーバ管理相当）
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const isAdminLike =
      member.permissions.has(PermissionFlagsBits.ManageGuild) ||
      member.permissions.has(PermissionFlagsBits.Administrator);
    if (!isAdminLike) {
      await interaction.reply({ content: '⛔ この操作は管理者のみ可能です。', ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();
    // 3秒ルール対策
    await interaction.deferReply({ ephemeral: true });

    let cfg = loadConfig();
    ensureRolesPanelConfig(cfg, interaction.guildId);
    const panel = cfg[interaction.guildId].rolesPanel;

    if (sub === 'add') {
      const role = interaction.options.getRole('role', true);
      const label = interaction.options.getString('label') ?? role.name;
      const emoji = interaction.options.getString('emoji') ?? null;

      panel.roles[role.id] = { label, emoji };
      saveConfig(cfg);
      await interaction.editReply({ content: `✅ 追加: <@&${role.id}>（ボタン: ${emoji ?? ''}${label}）\n「/roles setup」でパネルを更新してください。` });
      return;
    }

    if (sub === 'remove') {
      const role = interaction.options.getRole('role', true);
      delete panel.roles[role.id];
      saveConfig(cfg);
      await interaction.editReply({ content: `🗑️ 削除: <@&${role.id}>\n「/roles setup」でパネルを更新してください。` });
      return;
    }

    if (sub === 'list') {
      const lines = Object.entries(panel.roles).map(([rid, v]) =>
        `• <@&${rid}> : ${v.emoji ?? ''}${v.label ?? '(no label)'}`
      );
      await interaction.editReply({ content: lines.length ? lines.join('\n') : '（登録されているロールはありません）' });
      return;
    }

    if (sub === 'setup') {
      const targetChannel = interaction.options.getChannel('channel') ?? interaction.channel;
      if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
        await interaction.editReply({ content: '⛔ テキストチャンネルを指定してください。' });
        return;
      }
      const roleEntries = Object.entries(panel.roles);
      if (roleEntries.length === 0) {
        await interaction.editReply({ content: 'ℹ️ 配布対象ロールが未設定です。まずは `/roles add` で登録してください。' });
        return;
      }

      // ボタンを組み立て（1〜5個/行）
      const rows = [];
      let buf = [];
      for (const [rid, v] of roleEntries) {
        const btn = new ButtonBuilder()
          .setCustomId(`rolebtn:${rid}`)
          .setLabel(v.label ?? 'role')
          .setStyle(ButtonStyle.Secondary);
        if (v.emoji) btn.setEmoji(v.emoji);
        buf.push(btn);
        if (buf.length === 5) {
          rows.push(new ActionRowBuilder().addComponents(buf));
          buf = [];
        }
      }
      if (buf.length) rows.push(new ActionRowBuilder().addComponents(buf));

      // 既存メッセージを更新 or 新規作成（「常に最新の1件」にする）
      let messageId = panel.messageId;
      try {
        if (panel.channelId && panel.messageId) {
          const ch = await interaction.client.channels.fetch(panel.channelId);
          const msg = await ch.messages.fetch(panel.messageId);
          await msg.edit({ content: '✅ ロール配布パネル', components: rows });
          // チャンネルを変えたい場合は新規投下に切替
          if (ch.id !== targetChannel.id) {
            await msg.delete().catch(() => {});
            messageId = null;
          }
        }
      } catch {
        messageId = null;
      }

      if (!messageId) {
        const newMsg = await targetChannel.send({ content: '✅ ロール配布パネル', components: rows });
        panel.channelId = targetChannel.id;
        panel.messageId = newMsg.id;
        saveConfig(cfg);
      }

      await interaction.editReply({
        content: `✅ パネルを更新しました。\n場所: <#${panel.channelId}>`
      });
      return;
    }

    // 念のため
    await interaction.editReply({ content: '⛔ 未対応のサブコマンドです。' });
  }
};