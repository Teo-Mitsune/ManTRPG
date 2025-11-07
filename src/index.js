import 'dotenv/config';
import {
  Client, GatewayIntentBits, Collection, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, PermissionsBitField
} from 'discord.js';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { readdirSync } from 'fs';
import { DateTime } from 'luxon';
import { startScheduler } from './scheduler.js';
import {
  loadEvents, saveEvents, ensureGuildBucket, makeId,
  getGuildConfig
} from './utils/storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ZONE = 'Asia/Tokyo';

/* ---- 先にプロセス系ハンドラだけ定義（client不要） ---- */
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

/* ---- client は“宣言・初期化”してから使う ---- */
// GuildMembers は不要運用（必要なら有効化）
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/* ---- ここから client.on/once を安全に設定 ---- */
client.on('debug', (m) => console.log('[debug]', m));
client.on('warn',  (m) => console.warn('[warn]', m));
client.on('error', (e) => console.error('[error]', e));

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  startScheduler(client); // 30秒おきに通知チェック
});

/* ---- コマンド読み込み（top-level await OK: Node 24 ESM） ---- */
client.commands = new Collection();
const commandsPath = join(__dirname, 'commands');
for (const file of readdirSync(commandsPath)) {
  if (!file.endsWith('.js')) continue;
  const filePath = join(commandsPath, file);
  const fileUrl = pathToFileURL(filePath).href;
  const { command } = await import(fileUrl);
  client.commands.set(command.data.name, command);
}

/* ----------------- helpers ----------------- */
async function safeAck(interaction, ephemeral = true) {
  if (interaction.deferred || interaction.replied) return;
  try { await interaction.deferReply({ ephemeral }); } catch {}
}
async function safeEdit(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply({ ...payload, ephemeral: true });
    }
  } catch (e) { console.error('[safeEdit]', e); }
}
function formatJST(isoUtc) {
  return isoUtc ? DateTime.fromISO(isoUtc).setZone(ZONE).toFormat('yyyy-LL-dd HH:mm') : null;
}
function safe(v, fallback = '未設定') {
  return (v && String(v).trim().length) ? v : fallback;
}
function sortEventsForUI(list) {
  const key = (e) => safe(formatJST(e.datetimeUTC), '9999-12-31 23:59');
  return list.slice().sort((a, b) => (key(a) < key(b) ? -1 : 1));
}
function linesForEvent(ev) {
  return [
    `【日付】${formatJST(ev.datetimeUTC) ?? '未設定'}`,
    `【シナリオ名】${safe(ev.scenarioName)}`,
    `【システム名】${safe(ev.systemName)}`,
    `【GM名】<@${ev.createdBy}>`
  ];
}
function ensureParticipants(ev) {
  if (!Array.isArray(ev.participants)) ev.participants = [];
  return ev;
}
function slugifyName(name) {
  return name
    .toLowerCase()
    .replace(/[\s　]+/g, '-')
    .replace(/[^\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}0-9a-z-_]/giu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
}
async function createPrivateChannelForScenario(interaction, scenarioName, createdByUserId, categoryId) {
  const base = slugifyName(scenarioName) || 'scenario';
  const parent = await interaction.guild.channels.fetch(categoryId).catch(() => null);
  if (!parent || parent.type !== ChannelType.GuildCategory) {
    throw new Error('カテゴリが無効です。/eventadmin config_setcategory で正しいカテゴリを設定してください。');
  }
  const siblings = parent.children?.cache ?? (await interaction.guild.channels.fetch()).filter(ch => ch.parentId === parent.id);
  let name = base; let i = 2;
  while (siblings.find(ch => ch.name === name)) name = `${base}-${i++}`;

  const everyone = interaction.guild.roles.everyone.id;
  const botId = interaction.client.user.id;

  const ch = await interaction.guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parent.id,
    permissionOverwrites: [
      { id: everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: botId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageChannels] },
      { id: createdByUserId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
    ]
  });

  await ch.send({ content: `🗓️ **シナリオ部屋**\nこのチャンネルは予定作成により自動生成されました。\n作成者: <@${createdByUserId}>\nシナリオ名: **${scenarioName}**` });
  return ch.id;
}
async function grantAccessToPrivateChannel(guild, channelId, userId) {
  try {
    const ch = await guild.channels.fetch(channelId);
    if (!ch?.isTextBased()) return;
    await ch.permissionOverwrites.edit(userId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
  } catch (e) { console.error('grantAccess error:', e); }
}
async function revokeAccessFromPrivateChannel(guild, channelId, userId) {
  try {
    const ch = await guild.channels.fetch(channelId);
    if (!ch?.isTextBased()) return;
    await ch.permissionOverwrites.delete(userId).catch(() => {});
  } catch (e) { console.error('revokeAccess error:', e); }
}

/* ----------------- interactions ----------------- */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    const base = `[${new Date().toISOString()}] ${interaction.guild?.name ?? 'DM'} / ${interaction.user?.tag ?? 'unknown'}`;
    if (interaction.isChatInputCommand()) {
      console.log(`${base} → CMD /${interaction.commandName} ${interaction.options.getSubcommand(false) ?? ''}`);
    } else if (interaction.isButton()) {
      console.log(`${base} → BUTTON ${interaction.customId}`);
    } else if (interaction.isStringSelectMenu()) {
      console.log(`${base} → SELECT ${interaction.customId} values=${interaction.values?.join(',')}`);
    } else if (interaction.isModalSubmit()) {
      console.log(`${base} → MODAL ${interaction.customId}`);
    } else {
      console.log(`${base} → OTHER INTERACTION`);
    }
  } catch {}

  // Slash Command
  if (interaction.isChatInputCommand()) {
    const cmd = client.commands.get(interaction.commandName);
    if (!cmd) return;

    // /event ui → GUIパネル
    if (interaction.commandName === 'event' && interaction.options.getSubcommand(false) === 'ui') {
      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('evui_add').setLabel('予定を追加').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('evui_list').setLabel('予定一覧').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('evui_edit').setLabel('予定を編集').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('evui_remove').setLabel('予定を削除').setStyle(ButtonStyle.Danger),
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('evui_join').setLabel('参加する').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('evui_unjoin').setLabel('参加取消').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('evui_viewmembers').setLabel('参加者を見る').setStyle(ButtonStyle.Secondary),
      );
      await interaction.reply({ content: '📋 **予定パネル**', components: [row1, row2], ephemeral: true });
      return;
    }

    try {
      await cmd.execute(interaction);
    } catch (err) {
      console.error(err);
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: '⚠️ コマンド実行中にエラーが発生しました。', ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content: '⚠️ コマンド実行中にエラーが発生しました。', ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  // Buttons
  if (interaction.isButton()) {
    const id = interaction.customId;

    if (id.startsWith('rolebtn:')) {
      await safeAck(interaction);
      const roleId = id.split(':')[1];
      try {
        const role = interaction.guild.roles.cache.get(roleId) ?? await interaction.guild.roles.fetch(roleId).catch(() => null);
        if (!role) return await interaction.editReply({ content: '⛔ ロールが見つかりません。' });
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const has = member.roles.cache.has(role.id);
        if (has) await member.roles.remove(role.id);
        else     await member.roles.add(role.id);
        await interaction.editReply({ content: has ? `🔻 <@&${role.id}> を外しました。` : `🔺 <@&${role.id}> を付与しました。` });
      } catch (e) {
        console.error('[rolebtn]', e);
        await interaction.editReply({ content: '⚠️ ロールの付与/剥奪に失敗しました。Bot権限（Manage Roles）とロール順位を確認してください。' });
      }
      return;
    }

    // 追加
    if (id === 'evui_add') {
      const cfg = getGuildConfig(interaction.guildId);
      if (!cfg?.logChannelId) {
        await interaction.reply({ content: '⛔ 先に `/eventadmin config_setlogchannel` で「予定管理チャンネル」を設定してください。', ephemeral: true });
        return;
      }
      if (!cfg?.eventCategoryId) {
        await interaction.reply({ content: '⛔ 先に `/eventadmin config_setcategory` で「シナリオ用カテゴリ」を設定してください。', ephemeral: true });
        return;
      }

      const modal = new ModalBuilder().setCustomId('evui_add_modal').setTitle('予定を追加（JST）');
      const dateTime = new TextInputBuilder().setCustomId('evui_dt').setLabel('【日付】yyyy-MM-dd HH:mm（空でもOK）').setPlaceholder('例: 2025-11-06 19:00').setStyle(TextInputStyle.Short).setRequired(false);
      const scenario = new TextInputBuilder().setCustomId('evui_scenario').setLabel('【シナリオ名】（必須）').setStyle(TextInputStyle.Short).setRequired(true);
      const system = new TextInputBuilder().setCustomId('evui_system').setLabel('【システム名】（空でもOK）').setStyle(TextInputStyle.Short).setRequired(false);
      modal.addComponents(
        new ActionRowBuilder().addComponents(dateTime),
        new ActionRowBuilder().addComponents(scenario),
        new ActionRowBuilder().addComponents(system),
      );
      await interaction.showModal(modal);
      return;
    }

    // 一覧
    if (id === 'evui_list') {
      const events = loadEvents();
      const list = sortEventsForUI(events[interaction.guildId] ?? []);
      const me = interaction.user.id;
      if (list.length === 0) return await interaction.reply({ content: '（予定はありません）', ephemeral: true });

      const lines = list.slice(0, 20).map(e => {
        ensureParticipants(e);
        const whenTxt = formatJST(e.datetimeUTC) ?? '未設定';
        const joined = e.participants.includes(me);
        const isCreator = e.createdBy === me;
        let info = '';
        if (joined) info = ` / 参加者:${e.participants.length}人 / 参加済`;
        else if (isCreator) info = ` / 参加者:${e.participants.length}人 / （作成者）`;
        else info = ' / 参加者:非公開';
        return `• ${whenTxt} / ${safe(e.scenarioName)} / ${safe(e.systemName)}${info} | id:\`${e.id}\`${e.notified ? ' (通知済)' : ''}`;
      });
      await interaction.reply({ content: lines.join('\n'), ephemeral: true });
      return;
    }

    // 編集
    if (id === 'evui_edit') {
      const events = loadEvents();
      const list = sortEventsForUI(events[interaction.guildId] ?? []).slice(0, 25);
      if (list.length === 0) return await interaction.reply({ content: '（編集できる予定がありません）', ephemeral: true });

      const options = list.map(e => {
        const when = formatJST(e.datetimeUTC) ?? '未設定';
        const label = `${when} ${safe(e.scenarioName)}`.slice(0, 100);
        return { label, value: e.id, description: `${safe(e.systemName)}`.slice(0, 100) };
      });

      const select = new StringSelectMenuBuilder().setCustomId('evui_edit_select').setPlaceholder('編集する予定を選択').addOptions(options);
      await interaction.reply({ content: '✏️ 編集対象を選んでください', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
      return;
    }

    // 削除
    if (id === 'evui_remove') {
      const events = loadEvents();
      const list = sortEventsForUI(events[interaction.guildId] ?? []).slice(0, 25);
      if (list.length === 0) return await interaction.reply({ content: '（削除できる予定がありません）', ephemeral: true });

      const options = list.map(e => {
        const label = `${(formatJST(e.datetimeUTC) ?? '未設定')} ${safe(e.scenarioName)}`.slice(0, 100);
        return { label, value: e.id, description: `${safe(e.systemName)}`.slice(0, 100) };
      });

      const select = new StringSelectMenuBuilder().setCustomId('evui_remove_select').setPlaceholder('削除する予定を選択').addOptions(options);
      await interaction.reply({ content: '🗑️ 削除対象を選んでください', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
      return;
    }

    // 参加
    if (id === 'evui_join') {
      const events = loadEvents();
      const list = sortEventsForUI(events[interaction.guildId] ?? []).slice(0, 25);
      if (list.length === 0) return await interaction.reply({ content: '（参加できる予定がありません）', ephemeral: true });

      const options = list.map(e => {
        ensureParticipants(e);
        const when = formatJST(e.datetimeUTC) ?? '未設定';
        const label = `${when} ${safe(e.scenarioName)}`.slice(0, 100);
        return { label, value: e.id, description: `${safe(e.systemName)}`.slice(0, 100) };
      });

      const select = new StringSelectMenuBuilder().setCustomId('evui_join_select').setPlaceholder('参加する予定を選択').addOptions(options);
      await interaction.reply({ content: '🙋 参加する予定を選んでください', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
      return;
    }

    // 参加取消
    if (id === 'evui_unjoin') {
      const me = interaction.user.id;
      const events = loadEvents();
      const listAll = sortEventsForUI(events[interaction.guildId] ?? []);
      const list = listAll.filter(e => ensureParticipants(e).participants.includes(me)).slice(0, 25);
      if (list.length === 0) return await interaction.reply({ content: '（参加中の予定はありません）', ephemeral: true });

      const options = list.map(e => {
        const when = formatJST(e.datetimeUTC) ?? '未設定';
        const label = `${when} ${safe(e.scenarioName)}`.slice(0, 100);
        return { label, value: e.id, description: `${safe(e.systemName)}`.slice(0, 100) };
      });

      const select = new StringSelectMenuBuilder().setCustomId('evui_unjoin_select').setPlaceholder('参加を取り消す予定を選択').addOptions(options);
      await interaction.reply({ content: '↩️ 参加を取り消す予定を選んでください', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
      return;
    }

    // 参加者を見る
    if (id === 'evui_viewmembers') {
      const events = loadEvents();
      const list = sortEventsForUI(events[interaction.guildId] ?? []).slice(0, 25);
      if (list.length === 0) return await interaction.reply({ content: '（予定はありません）', ephemeral: true });

      const options = list.map(e => {
        ensureParticipants(e);
        const when = formatJST(e.datetimeUTC) ?? '未設定';
        const label = `${when} ${safe(e.scenarioName)}`.slice(0, 100);
        return { label, value: e.id, description: `${safe(e.systemName)}`.slice(0, 100) };
      });

      const select = new StringSelectMenuBuilder().setCustomId('evui_viewmembers_select').setPlaceholder('参加者を確認する予定を選択').addOptions(options);
      await interaction.reply({ content: '👀 参加者を確認する予定を選んでください（未参加者は人数・名前ともに非公開／作成者は人数のみ常時閲覧可）', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
      return;
    }
  }

  // Select Menu 確定
  if (interaction.isStringSelectMenu()) {
    // 編集
    if (interaction.customId === 'evui_edit_select') {
      const id = interaction.values[0];
      const events = loadEvents();
      const arr = events[interaction.guildId] ?? [];
      const ev = arr.find(e => e.id === id);
      if (!ev) return await interaction.reply({ content: '⛔ 選択した予定が見つかりません。', ephemeral: true });

      const currentDt = formatJST(ev.datetimeUTC) ?? '';
      const modal = new ModalBuilder().setCustomId(`evui_edit_modal:${id}`).setTitle('予定を編集（空でクリア可／シナリオ名空は不可）');
      const dateTime = new TextInputBuilder().setCustomId('evui_dt').setLabel('【日付】yyyy-MM-dd HH:mm（空でクリア）').setStyle(TextInputStyle.Short).setRequired(false).setValue(currentDt);
      const scenario = new TextInputBuilder().setCustomId('evui_scenario').setLabel('【シナリオ名】（空不可）').setStyle(TextInputStyle.Short).setRequired(true).setValue(ev.scenarioName ?? '');
      const system = new TextInputBuilder().setCustomId('evui_system').setLabel('【システム名】（空でクリア）').setStyle(TextInputStyle.Short).setRequired(false).setValue(ev.systemName ?? '');
      modal.addComponents(
        new ActionRowBuilder().addComponents(dateTime),
        new ActionRowBuilder().addComponents(scenario),
        new ActionRowBuilder().addComponents(system),
      );
      await interaction.showModal(modal);
      return;
    }

    // 削除
    if (interaction.customId === 'evui_remove_select') {
      await interaction.deferReply({ ephemeral: true });
      const id = interaction.values[0];
      const events = loadEvents();
      const arr = events[interaction.guildId] ?? [];
      const idx = arr.findIndex(e => e.id === id);
      if (idx === -1) return await interaction.editReply({ content: '⛔ 選択した予定が見つかりません。' });

      const [removed] = arr.splice(idx, 1);
      events[interaction.guildId] = arr;
      saveEvents(events);
      await interaction.editReply({ content: `🗑️ 削除しました：\n${linesForEvent(removed).join('\n')}\nID:\`${removed.id}\`` });
      return;
    }

    // 参加確定
    if (interaction.customId === 'evui_join_select') {
      await interaction.deferReply({ ephemeral: true });
      const id = interaction.values[0];
      const me = interaction.user.id;
      const events = loadEvents();
      const arr = events[interaction.guildId] ?? [];
      const ev = arr.find(e => e.id === id);
      if (!ev) return await interaction.editReply({ content: '⛔ 選択した予定が見つかりません。' });
      ensureParticipants(ev);
      if (!ev.participants.includes(me)) ev.participants.push(me);
      saveEvents(events);

      if (ev.privateChannelId) {
        await grantAccessToPrivateChannel(interaction.guild, ev.privateChannelId, me);
        try { const ch = await interaction.guild.channels.fetch(ev.privateChannelId); await ch?.send(`🙋 <@${me}> さんが参加しました。`); } catch {}
      }

      await interaction.editReply({ content: `🙋 参加を登録しました。\n${linesForEvent(ev).join('\n')}\n現在の参加者数: **${ev.participants.length}人**（参加者名はあなたのみ閲覧可）\nID:\`${ev.id}\`` });
      return;
    }

    // 参加取消確定
    if (interaction.customId === 'evui_unjoin_select') {
      await interaction.deferReply({ ephemeral: true });
      const id = interaction.values[0];
      const me = interaction.user.id;
      const events = loadEvents();
      const arr = events[interaction.guildId] ?? [];
      const ev = arr.find(e => e.id === id);
      if (!ev) return await interaction.editReply({ content: '⛔ 選択した予定が見つかりません。' });
      ensureParticipants(ev);
      ev.participants = ev.participants.filter(u => u !== me);
      saveEvents(events);

      if (ev.privateChannelId && ev.createdBy !== me) {
        await revokeAccessFromPrivateChannel(interaction.guild, ev.privateChannelId, me);
      }

      await interaction.editReply({ content: `↩️ 参加を取り消しました。\n${linesForEvent(ev).join('\n')}\n現在の参加者数: **${ev.participants.length}人**\nID:\`${ev.id}\`` });
      return;
    }

    // 参加者を見る
    if (interaction.customId === 'evui_viewmembers_select') {
      await interaction.deferReply({ ephemeral: true });
      const id = interaction.values[0];
      const me = interaction.user.id;
      const events = loadEvents();
      const arr = events[interaction.guildId] ?? [];
      const ev = arr.find(e => e.id === id);
      if (!ev) return await interaction.editReply({ content: '⛔ 選択した予定が見つかりません。' });
      ensureParticipants(ev);

      const isCreator = ev.createdBy === me;
      const joined = ev.participants.includes(me);
      if (!joined) {
        if (isCreator) {
          await interaction.editReply({ content: `👀 参加者数: **${ev.participants.length}人**\n（参加者の**名前**は、参加登録後に閲覧できます）\n\n${linesForEvent(ev).join('\n')}\nID:\`${ev.id}\`` });
        } else {
          await interaction.editReply({ content: `👀 参加者情報は**参加登録後**に閲覧できます。\n\n${linesForEvent(ev).join('\n')}\nID:\`${ev.id}\`` });
        }
        return;
      }

      const names = await Promise.all(ev.participants.map(async (uid) => {
        try { const member = await interaction.guild.members.fetch(uid); return `• ${member.user.tag} (<@${uid}>)`; }
        catch { return `• <@${uid}>`; }
      }));
      await interaction.editReply({ content: `👥 参加者（${ev.participants.length}人）\n${names.join('\n')}\n\n${linesForEvent(ev).join('\n')}\nID:\`${ev.id}\`` });
      return;
    }
  }

  // 未対応UIの安全処理
  if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
    await safeAck(interaction);
    const id = 'customId' in interaction ? interaction.customId : '(modal)';
    await safeEdit(interaction, { content: `⛔ この操作には現在のBotが対応していません。\n古いメッセージ/ボタンの可能性があります。\nID: \`${id}\`` });
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);
