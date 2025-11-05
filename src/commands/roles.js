import {
    SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ChannelType, PermissionFlagsBits
  } from 'discord.js';
  import { ensureRolesPanelConfig, saveConfig, loadConfig } from '../utils/storage.js';
  
  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }
  
  export const command = {
    data: new SlashCommandBuilder()
      .setName('roles')
      .setDescription('ロール配布パネルを管理します')
      .addSubcommand(sc =>
        sc.setName('setup')
          .setDescription('ロール置き場に最新パネルを投稿（前のパネルは自動削除）')
          .addChannelOption(o => o
            .setName('channel')
            .setDescription('投稿先チャンネル（ロール置き場）')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true))
          // 最大20個まで受け付け（ボタンは1行5個 × 最大4行 = 20個を推奨）
          .addRoleOption(o => o.setName('role1').setDescription('配布するロール1').setRequired(true))
          .addRoleOption(o => o.setName('role2').setDescription('配布するロール2').setRequired(false))
          .addRoleOption(o => o.setName('role3').setDescription('配布するロール3').setRequired(false))
          .addRoleOption(o => o.setName('role4').setDescription('配布するロール4').setRequired(false))
          .addRoleOption(o => o.setName('role5').setDescription('配布するロール5').setRequired(false))
          .addRoleOption(o => o.setName('role6').setDescription('配布するロール6').setRequired(false))
          .addRoleOption(o => o.setName('role7').setDescription('配布するロール7').setRequired(false))
          .addRoleOption(o => o.setName('role8').setDescription('配布するロール8').setRequired(false))
          .addRoleOption(o => o.setName('role9').setDescription('配布するロール9').setRequired(false))
          .addRoleOption(o => o.setName('role10').setDescription('配布するロール10').setRequired(false))
          .addRoleOption(o => o.setName('role11').setDescription('配布するロール11').setRequired(false))
          .addRoleOption(o => o.setName('role12').setDescription('配布するロール12').setRequired(false))
          .addRoleOption(o => o.setName('role13').setDescription('配布するロール13').setRequired(false))
          .addRoleOption(o => o.setName('role14').setDescription('配布するロール14').setRequired(false))
          .addRoleOption(o => o.setName('role15').setDescription('配布するロール15').setRequired(false))
          .addRoleOption(o => o.setName('role16').setDescription('配布するロール16').setRequired(false))
          .addRoleOption(o => o.setName('role17').setDescription('配布するロール17').setRequired(false))
          .addRoleOption(o => o.setName('role18').setDescription('配布するロール18').setRequired(false))
          .addRoleOption(o => o.setName('role19').setDescription('配布するロール19').setRequired(false))
          .addRoleOption(o => o.setName('role20').setDescription('配布するロール20').setRequired(false))
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .setDMPermission(false),
  
    /**
     * @param {import('discord.js').ChatInputCommandInteraction} interaction
     */
    async execute(interaction) {
      if (interaction.options.getSubcommand() !== 'setup') return;
  
      const channel = interaction.options.getChannel('channel', true);
  
      // 役職を収集
      const roles = [];
      for (let i = 1; i <= 20; i++) {
        const r = interaction.options.getRole(`role${i}`);
        if (r) roles.push(r);
      }
      if (roles.length === 0) {
        await interaction.reply({ content: '⛔ 1つ以上のロールを指定してください。', ephemeral: true });
        return;
      }
  
      // Botが操作できるロールか（階層/managedチェック）
      const me = interaction.guild.members.me;
      const highest = me.roles.highest;
      const notEditable = roles.filter(r => r.managed || r.comparePositionTo(highest) >= 0);
      if (notEditable.length) {
        await interaction.reply({
          content: `⛔ 次のロールはBotの権限/並び順の都合で操作できません：\n• ${notEditable.map(r => r.name).join('\n• ')}`,
          ephemeral: true
        });
        return;
      }
  
      // 既存パネルを削除 → 新規投稿
      const cfg = loadConfig();
      ensureRolesPanelConfig(cfg, interaction.guildId);
      const gcfg = cfg[interaction.guildId];
  
      // 既存メッセージを削除（あれば）
      if (gcfg.rolesPanel?.messageId && gcfg.rolesPanel?.channelId) {
        try {
          const oldCh = await interaction.guild.channels.fetch(gcfg.rolesPanel.channelId);
          if (oldCh?.isTextBased()) {
            const oldMsg = await oldCh.messages.fetch(gcfg.rolesPanel.messageId);
            await oldMsg.delete().catch(() => {});
          }
        } catch {
          // 取得できない（消されている/権限なし）場合は無視
        }
      }
  
      // コンポーネント（ボタン）を組む：5個/行
      const roleIds = roles.map(r => r.id);
      const rows = chunk(roleIds, 5).map(ids => {
        const buttons = ids.map(id =>
          new ButtonBuilder()
            .setCustomId(`rolebtn:${id}`)
            .setLabel(interaction.guild.roles.cache.get(id)?.name ?? 'role')
            .setStyle(ButtonStyle.Secondary)
        );
        return new ActionRowBuilder().addComponents(buttons);
      });
  
      const header = [
        '🔘 **ロール配布パネル**',
        'ボタンを押すとロールを付与/解除できます。',
        '（このメッセージは常に最新のロール設定で上書きされます）'
      ].join('\n');
  
      const msg = await channel.send({ content: header, components: rows });
  
      // 設定保存（このパネルのみを正とする）
      gcfg.rolesPanel = {
        channelId: channel.id,
        messageId: msg.id,
        roleIds
      };
      saveConfig(cfg);
  
      await interaction.reply({ content: `✅ パネルを更新しました：${msg.url}`, ephemeral: true });
    }
  };
  