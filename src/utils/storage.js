// src/utils/storage.js
// PostgreSQL 永続化対応 + メモリキャッシュ
// （events, guild_configs, app_configs を永続化）

import crypto from 'crypto';
import pg from 'pg';
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Please define it in .env');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------- スキーマ ----------
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
  gamemaster TEXT NULL,
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

CREATE TABLE IF NOT EXISTS app_configs (
  guild_id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);
`;

// ---------- メモリキャッシュ ----------
let cacheEvents = {};
let cacheGConfigs = {};
let cacheAppCfg = {};
let inited = false;
const clone = (o) => JSON.parse(JSON.stringify(o ?? {}));

// ---------- 初期ロード ----------
export async function restoreFromDB() {
  const client = await pool.connect();
  try {
    await client.query(initSQL);

    const cfg = await client.query('SELECT * FROM guild_configs');
    cacheGConfigs = {};
    for (const r of cfg.rows) {
      cacheGConfigs[r.guild_id] = {
        logChannelId: r.log_channel_id ?? null,
        eventCategoryId: r.event_category_id ?? null
      };
    }

    const evRes = await client.query('SELECT * FROM events');
    const paRes = await client.query('SELECT * FROM participants');
    const pmap = new Map();
    for (const p of paRes.rows) {
      if (!pmap.has(p.event_id)) pmap.set(p.event_id, []);
      pmap.get(p.event_id).push(p.user_id);
    }
    cacheEvents = {};
    for (const e of evRes.rows) {
      const ev = {
        id: e.id,
        datetimeUTC: e.datetime_utc ? e.datetime_utc.toISOString() : null,
        scenarioName: e.scenario_name,
        systemName: e.system_name,
        gamemaster: e.gamemaster,
        participants: pmap.get(e.id) ?? [],
        notified: !!e.notified,
        privateChannelId: e.private_channel_id
      };
      if (!cacheEvents[e.guild_id]) cacheEvents[e.guild_id] = [];
      cacheEvents[e.guild_id].push(ev);
    }

    const app = await client.query('SELECT guild_id, data FROM app_configs');
    cacheAppCfg = {};
    for (const r of app.rows) {
      cacheAppCfg[r.guild_id] = r.data ?? {};
    }

    inited = true;
    console.log('[storage] DB restored: guilds=%d', Object.keys(cacheEvents).length);
  } finally {
    client.release();
  }
}

// ---------- 公開API ----------
export function makeId(bytes = 6) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function loadEvents() {
  return clone(cacheEvents);
}

export function saveEvents(obj) {
  cacheEvents = clone(obj ?? {});
  void persistEventsToDB(cacheEvents).catch(e =>
    console.error('[storage] persist events failed:', e)
  );
}

export function ensureGuildBucket(eventsObj, guildId) {
  if (!eventsObj[guildId]) eventsObj[guildId] = [];
  return eventsObj;
}

export function getGuildConfig(guildId) {
  return clone(cacheGConfigs[guildId] ?? { logChannelId: null, eventCategoryId: null });
}

export function setGuildConfig(guildId, partial) {
  const cur = cacheGConfigs[guildId] ?? { logChannelId: null, eventCategoryId: null };
  const next = {
    logChannelId: partial.logChannelId ?? cur.logChannelId ?? null,
    eventCategoryId: partial.eventCategoryId ?? cur.eventCategoryId ?? null
  };
  cacheGConfigs[guildId] = next;
  void persistGuildConfigToDB(guildId, next).catch(e =>
    console.error('[storage] persist guild_config failed:', e)
  );
  return clone(next);
}

// app_configs (roles.js互換)
export function loadConfig() {
  return clone(cacheAppCfg);
}
export function saveConfig(obj) {
  cacheAppCfg = clone(obj ?? {});
  void persistAppConfigToDB(cacheAppCfg).catch(e =>
    console.error('[storage] persist app_config failed:', e)
  );
}
export function ensureRolesPanelConfig(appCfg, guildId) {
  appCfg[guildId] ??= {};
  const panel = appCfg[guildId].rolesPanel ?? {
    channelId: null,
    messageId: null,
    buttons: []
  };
  if (!Array.isArray(panel.buttons)) panel.buttons = [];
  appCfg[guildId].rolesPanel = panel;
  return panel;
}

// ---------- 内部永続化 ----------
async function persistEventsToDB(all) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM participants');
    await client.query('DELETE FROM events');

    const evInsert = `
      INSERT INTO events
        (id, guild_id, datetime_utc, scenario_name, system_name, gamemaster, notified, private_channel_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `;
    const paInsert = `INSERT INTO participants (event_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`;

    for (const gid of Object.keys(all ?? {})) {
      const arr = Array.isArray(all[gid]) ? all[gid] : [];
      for (const ev of arr) {
        await client.query(evInsert, [
          ev.id,
          gid,
          ev.datetimeUTC ? new Date(ev.datetimeUTC) : null,
          ev.scenarioName ?? '',
          ev.systemName ?? null,
          ev.gamemaster ?? null,
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

async function persistGuildConfigToDB(guildId, cfg) {
  const upsert = `
    INSERT INTO guild_configs (guild_id, log_channel_id, event_category_id)
    VALUES ($1,$2,$3)
    ON CONFLICT (guild_id)
    DO UPDATE SET log_channel_id = EXCLUDED.log_channel_id,
                  event_category_id = EXCLUDED.event_category_id
  `;
  await pool.query(upsert, [guildId, cfg.logChannelId, cfg.eventCategoryId]);
}

async function persistAppConfigToDB(all) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upsert = `
      INSERT INTO app_configs (guild_id, data)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (guild_id)
      DO UPDATE SET data = EXCLUDED.data
    `;
    for (const gid of Object.keys(all ?? {})) {
      await client.query(upsert, [gid, JSON.stringify(all[gid] ?? {})]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
