import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';


export const command = {
data: new SlashCommandBuilder()
.setName('say')
.setDescription('Bot に発言させます')
.addStringOption(opt =>
opt.setName('text').setDescription('発言内容').setRequired(true)
)
.setDefaultMemberPermissions(PermissionFlagsBits.SendMessages),
async execute(interaction) {
const text = interaction.options.getString('text', true);
await interaction.reply({ content: '✅ 送信しました', ephemeral: true });
await interaction.channel.send(text);
}
};