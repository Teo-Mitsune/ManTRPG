import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export const command = {
  data: new SlashCommandBuilder()
    .setName('rolebutton')
    .setDescription('ロールの付け外しボタンを投稿します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setDMPermission(false)
    .addRoleOption(o => o
      .setName('role')
      .setDescription('付け外しを許可するロール')
      .setRequired(true))
    .addStringOption(o => o
      .setName('label')
      .setDescription('ボタンに表示するテキスト（未指定ならロール名）')
      .setRequired(false))
    .addStringOption(o => o
      .setName('emoji')
      .setDescription('ボタンに表示する絵文字（任意）')
      .setRequired(false))
    .addChannelOption(o => o
      .setName('channel')
      .setDescription('ボタンを投稿するテキストチャンネル（未指定なら現在のチャンネル）')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false)),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const role = interaction.options.getRole('role', true);
    const label = interaction.options.getString('label') ?? role.name;
    const emoji = interaction.options.getString('emoji');
    const channel = interaction.options.getChannel('channel') ?? interaction.channel;

    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.editReply({ content: '⛔ テキストチャンネルを指定してください。' });
      return;
    }

    const button = new ButtonBuilder()
      .setCustomId(`rolebtn:${role.id}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary);
    if (emoji) button.setEmoji(emoji);

    const row = new ActionRowBuilder().addComponents(button);
    await channel.send({
      content: `🎚️ <@&${role.id}> を自分で付け外しできます。ボタンを押して切り替えてください。`,
      components: [row]
    });

    await interaction.editReply({ content: `✅ ボタンを投稿しました。場所: <#${channel.id}>` });
  }
};