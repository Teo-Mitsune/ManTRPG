import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const EVENTS_PATH = join(DATA_DIR, 'events.json');
const CONFIG_PATH = join(DATA_DIR, 'config.json');

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

/* ---------- events ---------- */
export function loadEvents() {
  ensureDataDir();
  if (!existsSync(EVENTS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(EVENTS_PATH, 'utf8'));
  } catch {
    return {};
  }
}
export function saveEvents(obj) {
  ensureDataDir();
  writeFileSync(EVENTS_PATH, JSON.stringify(obj, null, 2), 'utf8');
}
export function ensureGuildBucket(events, guildId) {
  if (!events[guildId]) events[guildId] = [];
}
export function makeId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);
}

/* ---------- config (logChannelId, eventCategoryId, rolesPanel etc.) ---------- */
export function loadConfig() {
  ensureDataDir();
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}
export function saveConfig(obj) {
  ensureDataDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2), 'utf8');
}

export function getGuildConfig(guildId) {
  const cfg = loadConfig();
  return cfg[guildId] ?? null;
}
export function setGuildConfig(guildId, patch) {
  const cfg = loadConfig();
  if (!cfg[guildId]) cfg[guildId] = {};
  cfg[guildId] = { ...cfg[guildId], ...patch };
  saveConfig(cfg);
  return cfg[guildId];
}

// roles panel (別機能で利用)
export function ensureRolesPanelConfig(cfg, guildId) {
  if (!cfg[guildId]) cfg[guildId] = {};
  if (!cfg[guildId].rolesPanel) {
    cfg[guildId].rolesPanel = {
      channelId: null,
      messageId: null,
      roleIds: []
    };
  }
  return cfg[guildId];
}
