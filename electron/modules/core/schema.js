// ── Prospector — SQLite 建表 + 迁移 ──────────────────────────────────────────
"use strict";

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS _schema (
    version INTEGER NOT NULL,
    applied_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS companies (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    raw_name    TEXT,
    country     TEXT,
    industry    TEXT,
    website     TEXT,
    phone       TEXT,
    address     TEXT,
    size        TEXT,
    main_routes TEXT,
    cargo_types TEXT,
    ports       TEXT,
    source      TEXT,
    score       INTEGER,
    backcheck_at TEXT,
    notes       TEXT,
    created_at  TEXT DEFAULT (datetime('now','localtime')),
    updated_at  TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS contacts (
    id            TEXT PRIMARY KEY,
    company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email         TEXT NOT NULL UNIQUE,
    first_name    TEXT,
    last_name     TEXT,
    title         TEXT,
    phone         TEXT,
    linkedin      TEXT,
    position      TEXT,
    contact_name  TEXT,
    client_type   TEXT DEFAULT 'unlabeled',
    category      TEXT,
    stage         TEXT DEFAULT 'cold',
    last_sent_at  TEXT,
    last_sent_acct TEXT,
    is_bounced    INTEGER DEFAULT 0,
    bounce_type   TEXT,
    bounce_reason TEXT,
    bounced_at    TEXT,
    tags          TEXT DEFAULT '[]',
    opp_stage     TEXT DEFAULT '待开发',
    assignee      TEXT DEFAULT '',
    _suspicious   INTEGER DEFAULT 0,
    followup_note TEXT,
    created_at    TEXT DEFAULT (datetime('now','localtime')),
    updated_at    TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS interactions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id    TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    type          TEXT NOT NULL,
    direction     TEXT,
    subject       TEXT,
    snippet       TEXT,
    email_uid     TEXT,
    email_account TEXT,
    created_at    TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_stage ON contacts(stage);
CREATE INDEX IF NOT EXISTS idx_contacts_bounced ON contacts(is_bounced);
CREATE INDEX IF NOT EXISTS idx_contacts_type ON contacts(client_type);
CREATE INDEX IF NOT EXISTS idx_companies_country ON companies(country);
CREATE INDEX IF NOT EXISTS idx_interactions_contact ON interactions(contact_id);
CREATE INDEX IF NOT EXISTS idx_interactions_time ON interactions(created_at);

CREATE TABLE IF NOT EXISTS send_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    row_index     INTEGER,
    to_email      TEXT,
    company       TEXT,
    subject       TEXT,
    message_id    TEXT,
    count         INTEGER DEFAULT 1,
    body_id       TEXT,
    stage         TEXT,
    lang          TEXT,
    client_type   TEXT,
    country       TEXT,
    tpl_info      TEXT,
    template_source TEXT,
    template_label TEXT,
    batch_label   TEXT,
    time          TEXT,
    time_beijing  TEXT,
    status        TEXT,
    error         TEXT,
    test_mode     INTEGER DEFAULT 0,
    account_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_send_log_time ON send_log(time_beijing);
CREATE INDEX IF NOT EXISTS idx_send_log_company ON send_log(company);
CREATE INDEX IF NOT EXISTS idx_send_log_status ON send_log(status);

CREATE TABLE IF NOT EXISTS inbox (
    uid         TEXT,
    account_id  TEXT,
    subject     TEXT,
    from_addr   TEXT,
    from_name   TEXT,
    date        TEXT,
    body        TEXT,
    type        TEXT,
    contact_company TEXT,
    contact_id  TEXT,
    contact_db_id TEXT,
    contact_tags TEXT,
    matched_contacts TEXT,
    processed   INTEGER DEFAULT 0,
    important   INTEGER DEFAULT 0,
    account_label TEXT,
    UNIQUE(account_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_inbox_type ON inbox(type);
CREATE INDEX IF NOT EXISTS idx_inbox_date ON inbox(date);
CREATE INDEX IF NOT EXISTS idx_inbox_processed ON inbox(processed);

CREATE TABLE IF NOT EXISTS opportunities (
    id            TEXT PRIMARY KEY,
    company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    contact_id    TEXT REFERENCES contacts(id),
    name          TEXT,
    stage         TEXT DEFAULT '触达中',
    amount        TEXT,
    currency      TEXT DEFAULT 'USD',
    notes         TEXT,
    created_at    TEXT DEFAULT (datetime('now','localtime')),
    updated_at    TEXT DEFAULT (datetime('now','localtime'))
);

  CREATE TABLE IF NOT EXISTS contact_notes (
    id            TEXT PRIMARY KEY,
    contact_id    TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    content       TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now','localtime')),
    updated_at    TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_notes_contact ON contact_notes(contact_id);
`;

function initSchema(db) {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  // 增量迁移：补全 CRM 字段
  try { db.exec("ALTER TABLE contacts ADD COLUMN assignee TEXT DEFAULT ''"); } catch { /* 已存在 */ }
  try { db.exec("ALTER TABLE contacts ADD COLUMN tags_updated_at TEXT DEFAULT ''"); } catch { /* 已存在 */ }
  try { db.exec("ALTER TABLE contacts ADD COLUMN contact_person TEXT DEFAULT ''"); } catch { /* 已存在 */ }
  try { db.exec("ALTER TABLE contacts ADD COLUMN _extra TEXT DEFAULT '{}'"); } catch { /* 已存在 */ }

  const v = db.prepare("SELECT MAX(version) as v FROM _schema").get()?.v || 0;
  if (v < SCHEMA_VERSION) {
    db.prepare("INSERT INTO _schema (version) VALUES (?)").run(SCHEMA_VERSION);
  }
}

module.exports = { initSchema, SCHEMA_VERSION };
