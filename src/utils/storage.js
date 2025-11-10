// src/utils/storage.js
import { Pool } from 'pg';

// ---- DB 接続（DATABASE_URL が無ければメモリのみで動作）----
const hasDB = !!process.env.DATABASE_URL;
const pool = hasDB
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

// ---- メモリ上のキャッシュ（既存コード互換: オブジェクト参照を使い回す）----
const MEM = {
  events: {}, // { [guildId]: Array<event> }
  config: {}, // { [guildId]: { ... } }
};

// ---- 起動時に呼び出して DB -> MEM を復元 ----
export async function restoreFromDB() {
  if (!pool) {
    console.warn('[storage] DB なしで起動（メモリ永続のみ）');
    return;
  }
  await ensureTables();
  const { rows } = await pool.query('SELECT guild_id, events, config FROM app_state');
  MEM.events = {};
  MEM.config = {};
  for (const r of rows) {
    // events は { [guildId]: [] } 形式で保存しているので吸い出す
    const ev = r.events && typeof r.events === 'object'
      ? (r.events[r.guild_id] ?? [])
      : [];
    MEM.events[r.guild_id] = ev;

    const cfg = r.config && typeof r.config === 'object'
      ? (r.config[r.guild_id] ?? r.config)
      : {};
    MEM.config[r.guild_id] = cfg;
  }
  console.log('[storage] restored from DB. guilds=', rows.length);
}

// ---- 既存コードが使う同期的 API（内部で DB 書き込みは fire-and-forget）----
export function loadEvents() {
  return MEM.events; // 参照を返す（既存コード互換）
}
export function ensureGuildBucket(allEvents, guildId) {
  if (!allEvents[guildId]) allEvents[guildId] = [];
}
export function makeId(n = 7) {
  const s = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let r = '';
  for (let i = 0; i < n; i++) r += s[Math.floor(Math.random() * s.length)];
  return r;
}

export function saveEvents(allEvents) {
  // MEM を置き換えるのではなく、中身を同期させる（参照維持）
  MEM.events = allEvents;

  // DB があればバックグラウンドで書き込み
  if (!pool) return;
  void persistAllEvents(allEvents).catch((e) =>
    console.error('[storage] persistAllEvents error', e)
  );
}

export function getGuildConfig(guildId) {
  return MEM.config[guildId] ?? null;
}
export function loadConfig() {
  return MEM.config; // 参照を返す
}
export function saveConfig(cfg) {
  MEM.config = cfg;
  if (!pool) return;
  void persistAllConfig(cfg).catch((e) =>
    console.error('[storage] persistAllConfig error', e)
  );
}

// ---- 内部：テーブル作成 ----
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      guild_id TEXT PRIMARY KEY,
      events   JSONB NOT NULL DEFAULT '{}'::jsonb,
      config   JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
}

// ---- 内部：全 guild の events を upsert ----
async function persistAllEvents(allEvents) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const guildIds = Object.keys(allEvents);
    for (const gid of guildIds) {
      const arr = allEvents[gid] ?? [];
      // { [gid]: [...] } 形式で保存（復元時に同じ形で吸い出す）
      const payload = { [gid]: arr };
      await client.query(
        `
        INSERT INTO app_state (guild_id, events, config)
        VALUES ($1, $2, COALESCE((SELECT config FROM app_state WHERE guild_id=$1),'{}'::jsonb))
        ON CONFLICT (guild_id)
        DO UPDATE SET events = EXCLUDED.events
        `,
        [gid, payload]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ---- 内部：全 guild の config を upsert ----
async function persistAllConfig(cfg) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const guildIds = Object.keys(cfg);
    for (const gid of guildIds) {
      const payload = { [gid]: cfg[gid] ?? {} };
      await client.query(
        `
        INSERT INTO app_state (guild_id, config, events)
        VALUES ($1, $2, COALESCE((SELECT events FROM app_state WHERE guild_id=$1),'{}'::jsonb))
        ON CONFLICT (guild_id)
        DO UPDATE SET config = EXCLUDED.config
        `,
        [gid, payload]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
