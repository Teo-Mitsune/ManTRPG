import { SlashCommandBuilder } from 'discord.js';


export const command = {
data: new SlashCommandBuilder().setName('ping').setDescription('Pong を返します'),
async execute(interaction) {
const sent = await interaction.reply({ content: '🏓 Pong!', fetchReply: true });
const latency = sent.createdTimestamp - interaction.createdTimestamp;
await interaction.editReply(`🏓 Pong! Latency: ${latency}ms`);
}
};