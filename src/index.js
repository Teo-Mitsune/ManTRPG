// src/index.js
import 'dotenv/config';
import {
  Client, GatewayIntentBits, Collection, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, PermissionsBitField
} from 'discord.js';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { readdirSync, existsSync } from 'fs';
import { DateTime } from 'luxon';
import { startScheduler } from './scheduler.js';
import {
  loadEvents, saveEvents, ensureGuildBucket, makeId,
  getGuildConfig
} from './utils/storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ZONE = 'Asia/Tokyo';

// ---- client & basic handlers ----
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on('debug', (m) => console.log('[debug]', m));
client.on('warn', (m) => console.warn('[warn]', m));
client.on('error', (e) => console.error('[error]', e));
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

// ---- command loader ----
client.commands = new Collection();
{
  // src/commands と ルート/commands の両対応（どちらか存在する方を使う）
  const candidates = [
    join(__dirname, 'commands'),        // /workspace/src/commands
    join(__dirname, '..', 'commands'),  // /workspace/commands
  ];
  const commandsPath = candidates.find(p => existsSync(p));
  if (!commandsPath) {
    throw new Error(`commands ディレクトリが見つかりません。試行: ${candidates.join(' , ')}`);
  }
  const files = readdirSync(commandsPath).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const fileUrl = pathToFileURL(join(commandsPath, file)).href;
    const { command } = await import(fileUrl);
    if (!command?.data?.name) continue;
    client.commands.set(command.data.name, command);
  }
  console.log('[loaded commands]', [...client.commands.keys()]);
}

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  startScheduler(client);
});

// ---- helpers ----
async function safeAck(interaction, ephemeral = true) {
  if (interaction.deferred || interaction.replied) return;
  try {
    await interaction.deferReply({ ephemeral });
  } catch { /* noop */ }
}
async function safeEdit(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply({ ...payload, ephemeral: true });
    }
  } catch (e) {
    console.error('[safeEdit]', e);
  }
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
  return (name || 'scenario')
    .toLowerCase()
    .replace(/[\s　]+/g, '-')
    .replace(/[^\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}0-9a-z-_]/giu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
}
async function createPrivateChannelForScenario(interaction, scenarioName, createdByUserId, categoryId) {
  const base = slugifyName(scenarioName);
  const parent = await interaction.guild.channels.fetch(categoryId).catch(() => null);
  if (!parent || parent.type !== ChannelType.GuildCategory) {
    throw new Error('カテゴリが無効です。/config setcategory で正しいカテゴリを設定してください。');
  }

  const all = await interaction.guild.channels.fetch();
  const siblings = all.filter(ch => ch.parentId === parent.id);
  let name = base;
  let i = 2;
  while (siblings.find(ch => ch.name === name)) {
    name = `${base}-${i++}`;
  }

  const everyone = interaction.guild.roles.everyone.id;
  const botId = interaction.client.user.id;

  const ch = await interaction.guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parent.id,
    permissionOverwrites: [
      { id: everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      {
        id: botId,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageChannels
        ]
      },
      {
        id: createdByUserId,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
        ]
      }
    ]
  });

  await ch.send({
    content: `🗓️ **シナリオ部屋**\nこのチャンネルは予定作成により自動生成されました。\n作成者: <@${createdByUserId}>\nシナリオ名: **${scenarioName}**`
  });

  return ch.id;
}
async function grantAccessToPrivateChannel(guild, channelId, userId) {
  try {
    const ch = await guild.channels.fetch(channelId);
    if (!ch?.isTextBased()) return;
    await ch.permissionOverwrites.edit(userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    });
  } catch (e) {
    console.error('grantAccess error:', e);
  }
}
async function revokeAccessFromPrivateChannel(guild, channelId, userId) {
  try {
    const ch = await guild.channels.fetch(channelId);
    if (!ch?.isTextBased()) return;
    await ch.permissionOverwrites.delete(userId).catch(() => {});
  } catch (e) {
    console.error('revokeAccess error:', e);
  }
}

// ---- interaction handler ----
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

    // /ui → 予定パネル（ここでハンドリング）
    if (interaction.commandName === 'ui') {
      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ui_add').setLabel('予定を追加').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('ui_list').setLabel('予定一覧').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ui_edit').setLabel('予定を編集').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('ui_remove').setLabel('予定を削除').setStyle(ButtonStyle.Danger),
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ui_join').setLabel('参加する').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('ui_unjoin').setLabel('参加取消').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ui_viewmembers').setLabel('参加者を見る').setStyle(ButtonStyle.Secondary),
      );
      await interaction.reply({ content: '📋 **予定パネル**', components: [row1, row2], ephemeral: true });
      return;
    }

    // その他は通常実行
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

  // ----- Buttons -----
  if (interaction.isButton()) {
    const id = interaction.customId;

    // ロール配布（既存互換: rolebtn:<roleId>）
    if (id.startsWith('rolebtn:')) {
      await safeAck(interaction);
      const roleId = id.split(':')[1];
      try {
        const role = interaction.guild.roles.cache.get(roleId) ?? await interaction.guild.roles.fetch(roleId).catch(() => null);
        if (!role) {
          await interaction.editReply({ content: '⛔ ロールが見つかりません。' });
          return;
        }
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const has = member.roles.cache.has(role.id);
        if (has) await member.roles.remove(role.id);
        else     await member.roles.add(role.id);

        await interaction.editReply({ content: has ? `🔻 <@&${role.id}> を外しました。` : `🔺 <@&${role.id}> を付与しました。` });
      } catch (e) {
        console.error('[rolebtn]', e);
        await interaction.editReply({ content: '⚠️ ロール付与/剥奪に失敗しました。Bot権限（Manage Roles）とロール順位をご確認ください。' });
      }
      return;
    }

    // 予定追加 → モーダル表示（customId: ui_add）
    if (id === 'ui_add') {
      const cfg = getGuildConfig(interaction.guildId);
      if (!cfg?.logChannelId) {
        await interaction.reply({ content: '⛔ 先に `/config setlogchannel` で「予定管理チャンネル」を設定してください。', ephemeral: true });
        return;
      }
      if (!cfg?.eventCategoryId) {
        await interaction.reply({ content: '⛔ 先に `/config setcategory` で「シナリオ用カテゴリ」を設定してください。', ephemeral: true });
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId('ui_add')
        .setTitle('予定を追加（JST）');

      const dateTime = new TextInputBuilder()
        .setCustomId('ui_dt')
        .setLabel('【日付】yyyy-MM-dd HH:mm（空でもOK）')
        .setPlaceholder('例: 2025-11-06 19:00')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      const scenario = new TextInputBuilder()
        .setCustomId('ui_scenario')
        .setLabel('【シナリオ名】（必須）')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const system = new TextInputBuilder()
        .setCustomId('ui_system')
        .setLabel('【システム名】（空でもOK）')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(dateTime),
        new ActionRowBuilder().addComponents(scenario),
        new ActionRowBuilder().addComponents(system),
      );

      await interaction.showModal(modal);
      return;
    }

    // 一覧
    if (id === 'ui_list') {
      const events = loadEvents();
      const list = sortEventsForUI(events[interaction.guildId] ?? []);
      const me = interaction.user.id;

      if (list.length === 0) {
        await interaction.reply({ content: '（予定はありません）', ephemeral: true });
        return;
      }

      const lines = list.slice(0, 20).map(e => {
        ensureParticipants(e);
        const whenTxt = formatJST(e.datetimeUTC) ?? '未設定';
        const joined = e.participants.includes(me);
        const isCreator = e.createdBy === me;

        let info = '';
        if (joined) {
          info = ` / 参加者:${e.participants.length}人 / 参加済`;
        } else if (isCreator) {
          info = ` / 参加者:${e.participants.length}人 / （作成者）`;
        } else {
          info = ' / 参加者:非公開';
        }

        return `• ${whenTxt} / ${safe(e.scenarioName)} / ${safe(e.systemName)}${info} | id:\`${e.id}\`${e.notified ? ' (通知済)' : ''}`;
      });

      await interaction.reply({ content: lines.join('\n'), ephemeral: true });
      return;
    }

    // 編集対象選択
    if (id === 'ui_edit') {
      const events = loadEvents();
      const list = sortEventsForUI(events[interaction.guildId] ?? []).slice(0, 25);

      if (list.length === 0) {
        await interaction.reply({ content: '（編集できる予定がありません）', ephemeral: true });
        return;
      }

      const options = list.map(e => {
        const when = formatJST(e.datetimeUTC) ?? '未設定';
        const label = `${when} ${safe(e.scenarioName)}`.slice(0, 100);
        return { label, value: e.id, description: `${safe(e.systemName)}`.slice(0, 100) };
      });

      const select = new StringSelectMenuBuilder()
        .setCustomId('ui_edit_select')
        .setPlaceholder('編集する予定を選択')
        .addOptions(options);

      const row = new ActionRowBuilder().addComponents(select);
      await interaction.reply({ content: '✏️ 編集対象を選んでください', components: [row], ephemeral: true });
      return;
    }

    // 削除対象選択
    if (id === 'ui_remove') {
      const events = loadEvents();
      const list = sortEventsForUI(events[interaction.guildId] ?? []).slice(0, 25);

      if (list.length === 0) {
        await interaction.reply({ content: '（削除できる予定がありません）', ephemeral: true });
        return;
      }

      const options = list.map(e => {
        const label = `${(formatJST(e.datetimeUTC) ?? '未設定')} ${safe(e.scenarioName)}`.slice(0, 100);
        return { label, value: e.id, description: `${safe(e.systemName)}`.slice(0, 100) };
      });

      const select = new StringSelectMenuBuilder()
        .setCustomId('ui_remove_select')
        .setPlaceholder('削除する予定を選択')
        .addOptions(options);

      const row = new ActionRowBuilder().addComponents(select);
      await interaction.reply({ content: '🗑️ 削除対象を選んでください', components: [row], ephemeral: true });
      return;
    }

    // 参加対象選択
    if (id === 'ui_join') {
      const events = loadEvents();
      const list = sortEventsForUI(events[interaction.guildId] ?? []).slice(0, 25);

      if (list.length === 0) {
        await interaction.reply({ content: '（参加できる予定がありません）', ephemeral: true });
        return;
      }

      const options = list.map(e => {
        ensureParticipants(e);
        const when = formatJST(e.datetimeUTC) ?? '未設定';
        const label = `${when} ${safe(e.scenarioName)}`.slice(0, 100);
        const desc = `${safe(e.systemName)}`.slice(0, 100);
        return { label, value: e.id, description: desc };
      });

      const select = new StringSelectMenuBuilder()
        .setCustomId('ui_join_select')
        .setPlaceholder('参加する予定を選択')
        .addOptions(options);

      const row = new ActionRowBuilder().addComponents(select);
      await interaction.reply({ content: '🙋 参加する予定を選んでください', components: [row], ephemeral: true });
      return;
    }

    // 参加取消対象選択
    if (id === 'ui_unjoin') {
      const me = interaction.user.id;
      const events = loadEvents();
      const listAll = sortEventsForUI(events[interaction.guildId] ?? []);
      const list = listAll.filter(e => ensureParticipants(e).participants.includes(me)).slice(0, 25);

      if (list.length === 0) {
        await interaction.reply({ content: '（参加中の予定はありません）', ephemeral: true });
        return;
      }

      const options = list.map(e => {
        const when = formatJST(e.datetimeUTC) ?? '未設定';
        const label = `${when} ${safe(e.scenarioName)}`.slice(0, 100);
        const desc = `${safe(e.systemName)}`.slice(0, 100);
        return { label, value: e.id, description: desc };
      });

      const select = new StringSelectMenuBuilder()
        .setCustomId('ui_unjoin_select')
        .setPlaceholder('参加を取り消す予定を選択')
        .addOptions(options);

      const row = new ActionRowBuilder().addComponents(select);
      await interaction.reply({ content: '↩️ 参加を取り消す予定を選んでください', components: [row], ephemeral: true });
      return;
    }

    // 参加者確認 対象選択
    if (id === 'ui_viewmembers') {
      const events = loadEvents();
      const list = sortEventsForUI(events[interaction.guildId] ?? []).slice(0, 25);

      if (list.length === 0) {
        await interaction.reply({ content: '（予定はありません）', ephemeral: true });
        return;
      }

      const options = list.map(e => {
        ensureParticipants(e);
        const when = formatJST(e.datetimeUTC) ?? '未設定';
        const label = `${when} ${safe(e.scenarioName)}`.slice(0, 100);
        const desc = `${safe(e.systemName)}`.slice(0, 100);
        return { label, value: e.id, description: desc };
      });

      const select = new StringSelectMenuBuilder()
        .setCustomId('ui_viewmembers_select')
        .setPlaceholder('参加者を確認する予定を選択')
        .addOptions(options);

      const row = new ActionRowBuilder().addComponents(select);
      await interaction.reply({ content: '👀 参加者を確認する予定を選んでください（未参加者は人数・名前ともに非公開／作成者は人数のみ常時閲覧可）', components: [row], ephemeral: true });
      return;
    }

    // 未対応ボタン → フォールバック
    await safeAck(interaction);
    await safeEdit(interaction, {
      content: `⛔ この操作には現在のBotが対応していません。\n古いメッセージ/ボタンの可能性があります。\nID: \`${id}\``
    });
    return;
  }

  // ----- Select Menu -----
  if (interaction.isStringSelectMenu()) {
    const cid = interaction.customId;

    // 編集：対象選択 → モーダル
    if (cid === 'ui_edit_select') {
      const id = interaction.values[0];
      const events = loadEvents();
      const arr = events[interaction.guildId] ?? [];
      const ev = arr.find(e => e.id === id);
      if (!ev) {
        await interaction.reply({ content: '⛔ 選択した予定が見つかりません。', ephemeral: true });
        return;
      }

      const currentDt = formatJST(ev.datetimeUTC) ?? '';
      const currentScenario = ev.scenarioName ?? '';
      const currentSystem = ev.systemName ?? '';

      const modal = new ModalBuilder()
        .setCustomId(`ui_edit_modal:${id}`)
        .setTitle('予定を編集（空でクリア可／シナリオ名空は不可）');

      const dateTime = new TextInputBuilder()
        .setCustomId('ui_dt')
        .setLabel('【日付】yyyy-MM-dd HH:mm（空でクリア）')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(currentDt);

      const scenario = new TextInputBuilder()
        .setCustomId('ui_scenario')
        .setLabel('【シナリオ名】（空不可）')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(currentScenario);

      const system = new TextInputBuilder()
        .setCustomId('ui_system')
        .setLabel('【システム名】（空でクリア）')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(currentSystem);

      modal.addComponents(
        new ActionRowBuilder().addComponents(dateTime),
        new ActionRowBuilder().addComponents(scenario),
        new ActionRowBuilder().addComponents(system),
      );

      await interaction.showModal(modal);
      return;
    }

    // 削除：確定
    if (cid === 'ui_remove_select') {
      await interaction.deferReply({ ephemeral: true });
      const id = interaction.values[0];
      const events = loadEvents();
      const arr = events[interaction.guildId] ?? [];
      const idx = arr.findIndex(e => e.id === id);
      if (idx === -1) {
        await interaction.editReply({ content: '⛔ 選択した予定が見つかりません。' });
        return;
      }
      const [removed] = arr.splice(idx, 1);
      events[interaction.guildId] = arr;
      saveEvents(events);

      await interaction.editReply({
        content: `🗑️ 削除しました：\n${linesForEvent(removed).join('\n')}\nID:\`${removed.id}\``
      });
      return;
    }

    // 参加：確定
    if (cid === 'ui_join_select') {
      await interaction.deferReply({ ephemeral: true });
      const id = interaction.values[0];
      const me = interaction.user.id;
      const events = loadEvents();
      const arr = events[interaction.guildId] ?? [];
      const ev = arr.find(e => e.id === id);
      if (!ev) {
        await interaction.editReply({ content: '⛔ 選択した予定が見つかりません。' });
        return;
      }
      ensureParticipants(ev);
      if (!ev.participants.includes(me)) ev.participants.push(me);
      saveEvents(events);

      if (ev.privateChannelId) {
        await grantAccessToPrivateChannel(interaction.guild, ev.privateChannelId, me);
        try {
          const ch = await interaction.guild.channels.fetch(ev.privateChannelId);
          await ch?.send(`🙋 <@${me}> さんが参加しました。`);
        } catch {}
      }

      await interaction.editReply({
        content: `🙋 参加を登録しました。\n${linesForEvent(ev).join('\n')}\n現在の参加者数: **${ev.participants.length}人**（参加者名はあなたのみ閲覧可）\nID:\`${ev.id}\``
      });
      return;
    }

    // 参加取消：確定
    if (cid === 'ui_unjoin_select') {
      await interaction.deferReply({ ephemeral: true });
      const id = interaction.values[0];
      const me = interaction.user.id;
      const events = loadEvents();
      const arr = events[interaction.guildId] ?? [];
      const ev = arr.find(e => e.id === id);
      if (!ev) {
        await interaction.editReply({ content: '⛔ 選択した予定が見つかりません。' });
        return;
      }
      ensureParticipants(ev);
      ev.participants = ev.participants.filter(u => u !== me);
      saveEvents(events);

      if (ev.privateChannelId && ev.createdBy !== me) {
        await revokeAccessFromPrivateChannel(interaction.guild, ev.privateChannelId, me);
      }

      await interaction.editReply({
        content: `↩️ 参加を取り消しました。\n${linesForEvent(ev).join('\n')}\n現在の参加者数: **${ev.participants.length}人**\nID:\`${ev.id}\``
      });
      return;
    }

    // 参加者を見る：確定
    if (cid === 'ui_viewmembers_select') {
      await interaction.deferReply({ ephemeral: true });
      const id = interaction.values[0];
      const me = interaction.user.id;
      const events = loadEvents();
      const arr = events[interaction.guildId] ?? [];
      const ev = arr.find(e => e.id === id);
      if (!ev) {
        await interaction.editReply({ content: '⛔ 選択した予定が見つかりません。' });
        return;
      }
      ensureParticipants(ev);

      const isCreator = ev.createdBy === me;
      const joined = ev.participants.includes(me);

      if (!joined) {
        if (isCreator) {
          await interaction.editReply({
            content: `👀 参加者数: **${ev.participants.length}人**\n（参加者の**名前**は、参加登録後に閲覧できます）\n\n${linesForEvent(ev).join('\n')}\nID:\`${ev.id}\``
          });
        } else {
          await interaction.editReply({
            content: `👀 参加者情報は**参加登録後**に閲覧できます。\n\n${linesForEvent(ev).join('\n')}\nID:\`${ev.id}\``
          });
        }
        return;
      }

      const names = await Promise.all(
        ev.participants.map(async (uid) => {
          try {
            const member = await interaction.guild.members.fetch(uid);
            return `• ${member.user.tag} (<@${uid}>)`;
          } catch {
            return `• <@${uid}>`;
          }
        })
      );

      await interaction.editReply({
        content: `👥 参加者（${ev.participants.length}人）\n${names.join('\n')}\n\n${linesForEvent(ev).join('\n')}\nID:\`${ev.id}\``
      });
      return;
    }

    // 未対応セレクト → フォールバック
    await safeAck(interaction);
    await safeEdit(interaction, {
      content: `⛔ この操作には現在のBotが対応していません。\n古いメッセージ/ボタンの可能性があります。\nID: \`${cid}\``
    });
    return;
  }

  // ----- Modal Submit -----
  if (interaction.isModalSubmit()) {
    const id = interaction.customId;

    // 予定 追加（customId: ui_add）
    if (id === 'ui_add') {
      try {
        const dtText   = interaction.fields.getTextInputValue('ui_dt')?.trim() ?? '';
        const scenario = interaction.fields.getTextInputValue('ui_scenario')?.trim() ?? '';
        const system   = interaction.fields.getTextInputValue('ui_system')?.trim() ?? '';

        if (!scenario) {
          await interaction.reply({ content: '⛔ シナリオ名は必須です。', ephemeral: true });
          return;
        }

        const cfg = getGuildConfig(interaction.guildId);
        if (!cfg?.logChannelId) {
          await interaction.reply({ content: '⛔ `/config setlogchannel` を先に設定してください。', ephemeral: true });
          return;
        }
        if (!cfg?.eventCategoryId) {
          await interaction.reply({ content: '⛔ `/config setcategory` を先に設定してください。', ephemeral: true });
          return;
        }

        // JST → UTC（空なら未設定扱い）
        let isoUTC = null;
        if (dtText) {
          const parsed = DateTime.fromFormat(dtText, 'yyyy-LL-dd HH:mm', { zone: ZONE });
          if (!parsed.isValid) {
            await interaction.reply({ content: '⛔ 日付の形式が不正です。`yyyy-MM-dd HH:mm` で入力してください。', ephemeral: true });
            return;
          }
          isoUTC = parsed.toUTC().toISO();
        }

        // 個室チャンネル作成（作成者に権限付与）
        const privateChannelId = await createPrivateChannelForScenario(
          interaction, scenario, interaction.user.id, cfg.eventCategoryId
        );

        // 保存
        const events = loadEvents();
        ensureGuildBucket(events, interaction.guildId);
        const ev = {
          id: makeId(7),
          datetimeUTC: isoUTC,
          scenarioName: scenario,
          systemName: system || null,
          createdBy: interaction.user.id,
          participants: [interaction.user.id],
          notified: false,
          privateChannelId
        };
        events[interaction.guildId].push(ev);
        saveEvents(events);

        await interaction.reply({
          content: [
            '✅ **予定を作成しました**',
            `【日付】${isoUTC ? DateTime.fromISO(isoUTC).setZone(ZONE).toFormat('yyyy-LL-dd HH:mm') + ' (JST)' : '未設定'}`,
            `【シナリオ名】${scenario}`,
            `【システム名】${system || '未設定'}`,
            `【GM名】<@${interaction.user.id}>`,
            `【部屋】<#${privateChannelId}>`,
            `ID:\`${ev.id}\``
          ].join('\n'),
          ephemeral: true
        });
      } catch (e) {
        console.error('[modal ui_add]', e);
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: '⚠️ 予定作成に失敗しました。', ephemeral: true }).catch(() => {});
        } else {
          await interaction.reply({ content: '⚠️ 予定作成に失敗しました。', ephemeral: true }).catch(() => {});
        }
      }
      return;
    }

    // 予定 編集（customId: ui_edit_modal:<eventId>）
    if (id.startsWith('ui_edit_modal:')) {
      const targetId = id.split(':')[1];
      try {
        const dtText   = interaction.fields.getTextInputValue('ui_dt')?.trim() ?? '';
        const scenario = interaction.fields.getTextInputValue('ui_scenario')?.trim() ?? '';
        const system   = interaction.fields.getTextInputValue('ui_system')?.trim() ?? '';

        if (!scenario) {
          await interaction.reply({ content: '⛔ シナリオ名は空にできません。', ephemeral: true });
          return;
        }

        let isoUTC = null;
        if (dtText) {
          const parsed = DateTime.fromFormat(dtText, 'yyyy-LL-dd HH:mm', { zone: ZONE });
          if (!parsed.isValid) {
            await interaction.reply({ content: '⛔ 日付の形式が不正です。`yyyy-MM-dd HH:mm` を指定してください。', ephemeral: true });
            return;
          }
          isoUTC = parsed.toUTC().toISO();
        }

        const events = loadEvents();
        const arr = events[interaction.guildId] ?? [];
        const ev = arr.find(e => e.id === targetId);
        if (!ev) {
          await interaction.reply({ content: '⛔ 対象の予定が見つかりません。', ephemeral: true });
          return;
        }

        ev.datetimeUTC = dtText ? isoUTC : null;   // 空なら日付クリア
        ev.scenarioName = scenario;                // 必須
        ev.systemName = system ? system : null;    // 空ならクリア
        saveEvents(events);

        await interaction.reply({
          content: [
            '✏️ **予定を更新しました**',
            `【日付】${ev.datetimeUTC ? DateTime.fromISO(ev.datetimeUTC).setZone(ZONE).toFormat('yyyy-LL-dd HH:mm') + ' (JST)' : '未設定'}`,
            `【シナリオ名】${ev.scenarioName}`,
            `【システム名】${ev.systemName ?? '未設定'}`,
            `【GM名】<@${ev.createdBy}>`,
            `ID:\`${ev.id}\``
          ].join('\n'),
          ephemeral: true
        });
      } catch (e) {
        console.error('[modal ui_edit_modal]', e);
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: '⚠️ 予定更新に失敗しました。', ephemeral: true }).catch(() => {});
        } else {
          await interaction.reply({ content: '⚠️ 予定更新に失敗しました。', ephemeral: true }).catch(() => {});
        }
      }
      return;
    }

    // 未対応モーダル → フォールバック
    await safeAck(interaction);
    await safeEdit(interaction, {
      content: `⛔ この操作には現在のBotが対応していません。\n古いメッセージ/ボタンの可能性があります。\nID: \`${id}\``
    });
    return;
  }

  // ここまでのどれにも当てはまらない → フォールバック
  if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
    await safeAck(interaction);
    const id = 'customId' in interaction ? interaction.customId : '(modal)';
    await safeEdit(interaction, {
      content: `⛔ この操作には現在のBotが対応していません。\n古いメッセージ/ボタンの可能性があります。\nID: \`${id}\``
    });
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);
