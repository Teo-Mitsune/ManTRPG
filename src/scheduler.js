import { DateTime } from 'luxon';
import { loadEvents, saveEvents, getGuildConfig } from './utils/storage.js';

const ZONE = 'Asia/Tokyo';
const INTERVAL_MS = 30_000; // 30秒ごと

function formatJST(isoUtc) {
  return isoUtc ? DateTime.fromISO(isoUtc).setZone(ZONE).toFormat('yyyy-LL-dd HH:mm') : null;
}

export function startScheduler(client) {
  setInterval(async () => {
    try {
      const events = loadEvents();
      const nowUTC = DateTime.now().toUTC();
      let changed = false;

      for (const [guildId, arr] of Object.entries(events)) {
        const cfg = getGuildConfig(guildId);
        const channelId = cfg?.logChannelId;
        if (!channelId) continue; // 未設定はスキップ

        for (const ev of arr) {
          if (ev.notified) continue;
          if (!ev.datetimeUTC) continue; // 日付未設定は通知しない

          const when = DateTime.fromISO(ev.datetimeUTC);
          if (!when.isValid) continue;

          if (when <= nowUTC && nowUTC.diff(when, 'seconds').seconds <= 60) {
            try {
              const guild = await client.guilds.fetch(guildId);
              const channel = await guild.channels.fetch(channelId);
              await channel.send({
                content: [
                  '⏰ **予定の時間です！**',
                  `【日付】${formatJST(ev.datetimeUTC)} (JST)`,
                  `【シナリオ名】${ev.scenarioName ?? '未設定'}`,
                  `【システム名】${ev.systemName ?? '未設定'}`,
                  `【GM名】<@${ev.createdBy}>`
                ].join('\n')
              });
              ev.notified = true;
              changed = true;
            } catch (e) {
              console.error('通知エラー:', e);
            }
          }
        }
      }

      if (changed) saveEvents(events);
    } catch (e) {
      console.error('スケジューラエラー:', e);
    }
  }, INTERVAL_MS);
}