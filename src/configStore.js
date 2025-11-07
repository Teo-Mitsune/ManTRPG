const fse = require('fs-extra');
const path = require('path');

const DB_DIR = path.join(__dirname, '..', 'db');
const DB_FILE = path.join(DB_DIR, 'config.json');

/**
 * 構造:
 * {
 *   guilds: {
 *     [guildId]: {
 *       defaultChannelId?: string,
 *       mentionRoleId?: string
 *     }
 *   }
 * }
 */
async function ensure() {
  await fse.ensureDir(DB_DIR);
  if (!(await fse.pathExists(DB_FILE))) {
    await fse.writeJSON(DB_FILE, { guilds: {} }, { spaces: 2 });
  }
}
async function readAll() { await ensure(); return fse.readJSON(DB_FILE); }
async function writeAll(d) { await ensure(); return fse.writeJSON(DB_FILE, d, { spaces: 2 }); }

async function getGuild(guildId) {
  const db = await readAll();
  return db.guilds[guildId] || {};
}
async function setGuild(guildId, partial) {
  const db = await readAll();
  db.guilds[guildId] = { ...(db.guilds[guildId] || {}), ...partial };
  await writeAll(db);
  return db.guilds[guildId];
}
async function resetGuild(guildId) {
  const db = await readAll();
  delete db.guilds[guildId];
  await writeAll(db);
}
module.exports = { getGuild, setGuild, resetGuild };
