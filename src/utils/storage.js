// src/utils/storage.js
// 既存コードの呼び出し互換API（同期）で、裏側をPostgreSQL永続化に差し替え。
// - loadEvents(): 同期。メモリキャッシュを返す
// - saveEvents(obj): 同期。キャッシュ更新して非同期でDBへ全置換保存
// - getGuildConfig(gid): 同期
// - setGuildConfig(gid, patch): 同期（非同期でDBへUPSERT）
// ※ 起動時にDBから読み込んでキャッシュ初期化（Top-level await）

import crypto from 'crypto';
import pg from 'pg';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Set it in environment variables.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Neon/Supabase等で必要
});

// -------- スキーマ作成（初回のみ） --------
const initSQL = `
CREATE TABLE IF NOT EXISTS guild_configs (
  guild_id TEXT PRIMARY KEY,
  log_channel_id TEXT,
  event_category_id TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  datetime_utc TIMESTAMPTZ NULL,
  scenario_name TEXT NOT NULL,
  system_name TEXT NULL,
  created_by TEXT NOT NULL,
  notified BOOLEAN NOT NULL DEFAULT FALSE,
  private_channel_id TEXT NULL
);
CREATE TABLE IF NOT EXISTS participants (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_events_guild ON events(guild_id);
CREATE INDEX IF NOT EXISTS idx_participants_event ON participants(event_id);
`;

// -------- メモリキャッシュ --------
let cacheEvents = {}; // { [guildId]: Array<Event> }
let cacheConfig = {}; // { [guildId]: { logChannelId, eventCategoryId } }
let inited = false;

// 深いところまで弄られても壊れないように、最低限のクローンを返す
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// DB -> キャッシュ へ全ロード
async function loadAllFromDB() {
  const client = await pool.connect();
  try {
    await client.query(initSQL);

    const cfg = await client.query('SELECT * FROM guild_configs');
    cacheConfig = {};
    for (const r of cfg.rows) {
      cacheConfig[r.guild_id] = {
        logChannelId: r.log_channel_id ?? null,
        eventCategoryId: r.event_category_id ?? null
      };
    }

    const eventsRes = await client.query('SELECT * FROM events');
    const partsRes  = await client.query('SELECT * FROM participants');

    const pmap = new Map(); // event_id -> [user_id]
    for (const p of partsRes.rows) {
      if (!pmap.has(p.event_id)) pmap.set(p.event_id, []);
      pmap.get(p.event_id).push(p.user_id);
    }

    cacheEvents = {};
    for (const e of eventsRes.rows) {
      const ev = {
        id: e.id,
        datetimeUTC: e.datetime_utc ? e.datetime_utc.toISOString() : null,
        scenarioName: e.scenario_name,
        systemName: e.system_name,
        createdBy: e.created_by,
        participants: pmap.get(e.id) ?? [],
        notified: !!e.notified,
        privateChannelId: e.private_channel_id
      };
      if (!cacheEvents[e.guild_id]) cacheEvents[e.guild_id] = [];
      cacheEvents[e.guild_id].push(ev);
    }
    inited = true;
    console.log('[storage] DB loaded: configs=%d, guilds=%d',
      Object.keys(cacheConfig).length, Object.keys(cacheEvents).length);
  } finally {
    client.release();
  }
}

// 起動時に同期完了させる（Top-level await）
await loadAllFromDB();

// --------- 公開API（既存互換・同期） ---------
export function makeId(bytes = 6) {
  return crypto.randomBytes(bytes).toString('hex'); // 12 hex
}

// { guildId: Event[] } を返す（同期・キャッシュ）
export function loadEvents() {
  if (!inited) {
    // 理論上ここには来ないはずだが、一応フェイルセーフ
    console.warn('[storage] loadEvents before init; returning empty object');
    return {};
  }
  return clone(cacheEvents);
}

// 受け取った全体でキャッシュ更新 → 非同期でDBへ全置換保存
export function saveEvents(eventsObj) {
  cacheEvents = clone(eventsObj ?? {});
  // 非同期でDB反映
  void persistEventsToDB(cacheEvents).catch(err => {
    console.error('[storage] persist events failed:', err);
  });
}

// guildId の配列バケツを必ず用意（同期・キャッシュ）
export function ensureGuildBucket(eventsObj, guildId) {
  if (!eventsObj[guildId]) eventsObj[guildId] = [];
  return eventsObj;
}

// 設定取得（同期・キャッシュ）
export function getGuildConfig(guildId) {
  return clone(cacheConfig[guildId] ?? { logChannelId: null, eventCategoryId: null });
}

// 設定更新（同期・キャッシュ更新 → 非同期UPSERT）
export function setGuildConfig(guildId, patch) {
  const cur = cacheConfig[guildId] ?? { logChannelId: null, eventCategoryId: null };
  const next = {
    logChannelId: (Object.prototype.hasOwnProperty.call(patch, 'logChannelId') ? patch.logChannelId : cur.logChannelId) ?? null,
    eventCategoryId: (Object.prototype.hasOwnProperty.call(patch, 'eventCategoryId') ? patch.eventCategoryId : cur.eventCategoryId) ?? null
  };
  cacheConfig[guildId] = next;
  void persistConfigToDB(guildId, next).catch(err => {
    console.error('[storage] persist config failed:', err);
  });
  return clone(next);
}

// --------- 内部：DB保存実体（非同期） ---------
async function persistEventsToDB(all) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM participants');
    await client.query('DELETE FROM events');

    const evInsert = `
      INSERT INTO events
        (id, guild_id, datetime_utc, scenario_name, system_name, created_by, notified, private_channel_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `;
    const paInsert = `INSERT INTO participants (event_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`;

    for (const gid of Object.keys(all)) {
      const arr = Array.isArray(all[gid]) ? all[gid] : [];
      for (const ev of arr) {
        await client.query(evInsert, [
          ev.id,
          gid,
          ev.datetimeUTC ? new Date(ev.datetimeUTC) : null,
          ev.scenarioName ?? '',
          ev.systemName ?? null,
          ev.createdBy ?? 'unknown',
          !!ev.notified,
          ev.privateChannelId ?? null
        ]);
        const ps = Array.isArray(ev.participants) ? ev.participants : [];
        for (const uid of ps) {
          await client.query(paInsert, [ev.id, uid]);
        }
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function persistConfigToDB(guildId, cfg) {
  const upsert = `
    INSERT INTO guild_configs (guild_id, log_channel_id, event_category_id)
    VALUES ($1,$2,$3)
    ON CONFLICT (guild_id)
    DO UPDATE SET log_channel_id = EXCLUDED.log_channel_id,
                  event_category_id = EXCLUDED.event_category_id
  `;
  await pool.query(upsert, [guildId, cfg.logChannelId, cfg.eventCategoryId]);
}
