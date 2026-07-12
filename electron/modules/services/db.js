// ── Prospector — 数据库单例 ─────────────────────────────────────────────────
"use strict";

const path = require("path");
const { APP_ROOT, ensureRuntimeDirs } = require("../config");
const { initSchema } = require("../core/schema");
const { Log } = require("../core/logger");

let _db = null;

function getDb() {
  if (_db) return _db;
  ensureRuntimeDirs();
  const dbPath = path.join(APP_ROOT, "data", "prospector.db");
  const Database = require("better-sqlite3");
  _db = new Database(dbPath);
  initSchema(_db);
  Log.info("DB", "SQLite 已连接: " + dbPath);
  return _db;
}

function closeDb() {
  if (_db) {
    // ponytail: 退出前 WAL checkpoint，合并 -wal 文件回主 DB
    try { _db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* 静默 */ }
    _db.close();
    _db = null;
    Log.info("DB", "SQLite 已关闭");
  }
}

module.exports = { getDb, closeDb };
