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
  getGuildConfig, restoreFromDB
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

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);

  // --- 起動時に Neon(DB) → メモリへ復元 ---
  try {
    const restored = await restoreFromDB();
    console.log(`[restoreFromDB] events restored: ${restored.eventCount}, guilds: ${restored.guildCount}`);
  } catch (e) {
    console.error('[restoreFromDB] failed:', e);
  }

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
async function postToLogChannel(client, guildId, content) {
  try {
    const { getGuildConfig } = await import('./utils/storage.js');
    const cfg = getGuildConfig(guildId);

    if (!cfg?.logChannelId) {
      console.warn('[log] skip: logChannelId not set for guild', guildId);
      return;
    }

    console.log('[log] trying to post to', cfg.logChannelId, 'guild', guildId);

    const ch = await client.channels.fetch(cfg.logChannelId).catch((e) => {
      console.error('[log] fetch channel failed:', e);
      return null;
    });

    if (!ch) {
      console.error('[log] channel not found:', cfg.logChannelId);
      return;
    }

    if (!ch.isTextBased()) {
      console.error('[log] channel is not text-based:', ch.id, ch.type);
      return;
    }

    await ch.send({ content });
    console.log('[log] posted to channel', ch.id);
  } catch (e) {
    console.error('[log] failed to post:', e);
  }
}

// ---- 掲示板（最新版1件のみ維持） ----
async function composeBoardContent(guildId) {
  const eventsAll = loadEvents();
  const list = (eventsAll[guildId] ?? []).slice().sort((a, b) => {
    const ka = formatJST(a.datetimeUTC) ?? '9999-12-31 23:59';
    const kb = formatJST(b.datetimeUTC) ?? '9999-12-31 23:59';
    return ka < kb ? -1 : 1;
  });

  if (list.length === 0) {
    return [
      '🗓️ **現在、予定はありません**',
      '新規作成は `/ui` → 「予定を追加」からどうぞ。'
    ].join('\n');
  }

  const lines = list.map(e => {
    const when = formatJST(e.datetimeUTC) ?? '未設定';
    const sys = safe(e.systemName);
    const scen = safe(e.scenarioName);
    const n = Array.isArray(e.participants) ? e.participants.length : 0;
    return `• ${when} / ${scen} / ${sys} — 参加者: ${n}人`;
  });

  return `🗓️ **セッション募集一覧（最新版）**\n` + lines.join('\n') + `\n\n※このメッセージは最新状態を反映します。`;
}

async function updateEventBoardMessage(client, guildId) {
  // app config から掲示板設定を取得
  const { loadConfig, saveConfig } = await import('./utils/storage.js');
  const appCfg = loadConfig();
  const board = appCfg[guildId]?.eventBoard ?? { channelId: null, messageId: null };
  if (!board.channelId) return; // 未設定なら何もしない

  const content = await composeBoardContent(guildId);

  try {
    const ch = await client.channels.fetch(board.channelId);
    if (!ch?.isTextBased()) return;

    if (board.messageId) {
      // 既存を編集（なければ新規投稿）
      try {
        const msg = await ch.messages.fetch(board.messageId);
        await msg.edit({ content });
        return; // 編集できたら終了（常に1件を維持）
      } catch {
        // 既存メッセージが無い/削除済み → 新規投稿へ
      }
    }

    // 新規投稿
    const newMsg = await ch.send({ content });

    // 直前のメッセージが別にあれば掃除（保険）
    if (board.messageId && board.messageId !== newMsg.id) {
      try {
        const oldMsg = await ch.messages.fetch(board.messageId);
        await oldMsg.delete().catch(() => {});
      } catch {}
    }

    // ID を保存
    appCfg[guildId] ??= {};
    appCfg[guildId].eventBoard = { channelId: board.channelId, messageId: newMsg.id };
    saveConfig(appCfg);
  } catch (e) {
    console.error('[board] update failed:', e);
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
    `【GM名】${ev.gamemasterName ?? '未設定'}`
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

/**
 * シナリオ用の個室を作成する。
 * roomMode によって挙動を切り替え：
 *  - 'channel'  : 指定カテゴリ配下にテキストチャンネルを1つ作成（従来仕様）
 *  - 'category' : シナリオ名でカテゴリを作成し、その中にテキストチャンネルを1つ作成
 *
 * 戻り値は「メインで使うテキストチャンネルの ID」
 */
async function createPrivateChannelForScenario(interaction, scenarioName, createdByUserId, categoryId, roomMode = 'channel') {
  const base = slugifyName(scenarioName);
  const everyone = interaction.guild.roles.everyone.id;
  const botId = interaction.client.user.id;

  // ---- カテゴリモード：カテゴリ + 中のテキストチャンネルを作成 ----
  if (roomMode === 'category') {
    const allChannels = await interaction.guild.channels.fetch();
    const existingCategories = allChannels.filter(ch => ch.type === ChannelType.GuildCategory);

    let catName = base;
    let i = 2;
    while (existingCategories.find(ch => ch.name === catName)) {
      catName = `${base}-${i++}`;
    }

    const parentCategory = await interaction.guild.channels.create({
      name: catName,
      type: ChannelType.GuildCategory,
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

    // カテゴリの中に実際のテキストチャンネル（個室）を作る
    const textChannel = await interaction.guild.channels.create({
      name: 'テキスト',
      type: ChannelType.GuildText,
      parent: parentCategory.id,
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

    await textChannel.send({
      content: `🗓️ **シナリオ部屋**\nこのチャンネルは予定作成により自動生成されました。\n作成者: <@${createdByUserId}>\nシナリオ名: **${scenarioName}**`
    });

    return textChannel.id;
  }

  // ---- チャンネルモード（従来通り）：指定カテゴリ配下にテキストチャンネルを作成 ----
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

      const gm = new TextInputBuilder()
        .setCustomId('ui_gamemaster')
        .setLabel('【GM名】（空でもOK）')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      // 部屋タイプ選択欄（ch / cat）
      const roommode = new TextInputBuilder()
        .setCustomId('ui_roommode')
        .setLabel('【部屋タイプ】ch=チャンネル / cat=カテゴリ（空でもOK）')
        .setPlaceholder('例: ch / cat （未入力なら ch）')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(dateTime),
        new ActionRowBuilder().addComponents(scenario),
        new ActionRowBuilder().addComponents(system),
        new ActionRowBuilder().addComponents(gm),
        new ActionRowBuilder().addComponents(roommode),
      );

      await interaction.showModal(modal);
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
      await interaction.reply({
        content: '👀 参加者を確認する予定を選んでください（未参加者は人数・名前ともに非公開／作成者は人数のみ常時閲覧可）',
        components: [row],
        ephemeral: true
      });
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
      const currentGamemaster = ev.gamemasterName ?? '';

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

      const gamemaster = new TextInputBuilder()
        .setCustomId('ui_gamemaster')
        .setLabel('【GM名】（空でクリア）')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(currentGamemaster);

      modal.addComponents(
        new ActionRowBuilder().addComponents(dateTime),
        new ActionRowBuilder().addComponents(scenario),
        new ActionRowBuilder().addComponents(system),
        new ActionRowBuilder().addComponents(gamemaster)
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
      await updateEventBoardMessage(interaction.client, interaction.guildId);

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
      await updateEventBoardMessage(interaction.client, interaction.guildId);

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
      await updateEventBoardMessage(interaction.client, interaction.guildId);

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

  // ----- Modal Submit ----- (唯一のモーダル処理ブロック)
  if (interaction.isModalSubmit()) {
    const id = interaction.customId;

    // 予定 追加（customId: ui_add）
    if (id === 'ui_add') {
      try {
        const dtText      = interaction.fields.getTextInputValue('ui_dt')?.trim() ?? '';
        const scenario    = interaction.fields.getTextInputValue('ui_scenario')?.trim() ?? '';
        const system      = interaction.fields.getTextInputValue('ui_system')?.trim() ?? '';
        const gamemaster  = interaction.fields.getTextInputValue('ui_gamemaster')?.trim() ?? '';
        const roomModeRaw = interaction.fields.getTextInputValue('ui_roommode')?.trim().toLowerCase() ?? '';

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

        // 部屋モード判定（未入力なら channel）
        let roomMode = 'channel';
        if (roomModeRaw) {
          if (['cat', 'category', 'c'].includes(roomModeRaw)) {
            roomMode = 'category';
          } else if (['ch', 'channel'].includes(roomModeRaw)) {
            roomMode = 'channel';
          } else {
            await interaction.reply({
              content: '⛔ 部屋タイプは `ch` または `cat` で指定してください（空欄でもOK）。',
              ephemeral: true
            });
            return;
          }
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

        // 個室チャンネル作成（roomMode により挙動切替）
        const privateChannelId = await createPrivateChannelForScenario(
          interaction, scenario, interaction.user.id, cfg.eventCategoryId, roomMode
        );

        // 保存
        const events = loadEvents();
        ensureGuildBucket(events, interaction.guildId);
        const ev = {
          id: makeId(7),
          datetimeUTC: isoUTC,
          scenarioName: scenario,
          systemName: system || null,
          gamemasterName: gamemaster || null,
          createdBy: interaction.user.id,        // ★★ ここ重要：createdBy を必ず入れる ★★
          participants: [interaction.user.id],
          notified: false,
          privateChannelId
        };
        events[interaction.guildId].push(ev);
        saveEvents(events);

        // 掲示板を更新（最新版1件維持）
        await updateEventBoardMessage(interaction.client, interaction.guildId);

        // ログチャンネル通知
        const modeLabel = roomMode === 'category'
          ? 'カテゴリ+個室チャンネル'
          : 'カテゴリ内の個室チャンネル';

        await postToLogChannel(interaction.client, interaction.guildId, [
          '🗓️ **予定追加**',
          `<@everyone>`,
          `【日付】${isoUTC ? DateTime.fromISO(isoUTC).setZone(ZONE).toFormat('yyyy-LL-dd HH:mm') + ' (JST)' : '未設定'}`,
          `【シナリオ名】${scenario}`,
          `【システム名】${system || '未設定'}`,
          `【GM名】${gamemaster || '未設定'}`,
          `【作成者】<@${interaction.user.id}>`,
          `【部屋】<#${privateChannelId}> （${modeLabel}）`,
          `ID:\`${ev.id}\``
        ].join('\n'));

        // 作成者へエフェメラル返信
        await interaction.reply({
          content: [
            '✅ **予定を作成しました**',
            `【日付】${isoUTC ? DateTime.fromISO(isoUTC).setZone(ZONE).toFormat('yyyy-LL-dd HH:mm') + ' (JST)' : '未設定'}`,
            `【シナリオ名】${scenario}`,
            `【システム名】${system || '未設定'}`,
            `【GM名】${gamemaster || '未設定'}`,
            `【作成者】<@${interaction.user.id}>`,
            `【部屋】<#${privateChannelId}>`,
            `【部屋タイプ】${modeLabel}`,
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
        const gamemaster = interaction.fields.getTextInputValue('ui_gamemaster')?.trim() ?? '';

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

        ev.datetimeUTC = dtText ? isoUTC : null;       // 空なら日付クリア
        ev.scenarioName = scenario;                    // 必須
        ev.systemName = system ? system : null;        // 空ならクリア
        ev.gamemasterName = gamemaster ? gamemaster : null; // GM名を更新
        saveEvents(events);

        // 掲示板更新
        await updateEventBoardMessage(interaction.client, interaction.guildId);

        await interaction.reply({
          content: [
            '✏️ **予定を更新しました**',
            `【日付】${ev.datetimeUTC ? DateTime.fromISO(ev.datetimeUTC).setZone(ZONE).toFormat('yyyy-LL-dd HH:mm') + ' (JST)' : '未設定'}`,
            `【シナリオ名】${ev.scenarioName}`,
            `【システム名】${ev.systemName ?? '未設定'}`,
            `【GM名】${ev.gamemasterName ?? '未設定'}`,
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
