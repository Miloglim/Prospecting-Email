// ── 建表 SQL 单一事实源 ──────────────────────────────────────────
// 生产（runMigrations）与评测沙箱（tests/eval）共用这一份，杜绝手抄 DDL 漂移。
// 列改动直接改这里；旧库的存量列迁移仍走 runMigrations 里的 ALTER 补丁（幂等）。
// 纯字符串、零依赖，评测侧可安全 import（不受 db 模块 mock 影响）。
export const BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS email_accounts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  email text NOT NULL UNIQUE,
  provider text DEFAULT 'smtp' NOT NULL,
  smtp_host text, smtp_port integer,
  imap_host text, imap_port integer,
  encrypted_pass text NOT NULL, display_name text, signature text,
  consecutive_fails integer DEFAULT 0 NOT NULL,
  circuit_open_at text, circuit_reset_after text, circuit_reason text,
  last_fetch_error text, last_fetch_at text,
  fetch_fail_count integer DEFAULT 0 NOT NULL,
  is_active integer DEFAULT 1 NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
-- 发信受阻事件（规范 docs/sender-block-circuit-spec.md）：服务商反垃圾/限流拦截通知记在发信账号头上，
-- 不记成收件人退信。message_id 唯一 = 幂等键（同一封通知被反复点开只记一次）。
CREATE TABLE IF NOT EXISTS send_block_events (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  account_id integer NOT NULL,
  message_id text NOT NULL UNIQUE,
  code text NOT NULL, excerpt text,
  occurred_at text NOT NULL, created_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS companies (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  name text NOT NULL, domain text, industry text, country text, size text,
  backcheck_data text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
-- 按公司名查 id（导入逐行、联系人档案保存等高频路径）；原先零索引全表扫
CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(name);
CREATE TABLE IF NOT EXISTS contacts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  email text NOT NULL UNIQUE,
  company_id integer, first_name text, last_name text,
  title text, phone text, linkedin text,
  country text, client_type text, language text,
  stage text DEFAULT 'cold',
  status text DEFAULT '',
  tags text,
  extra text DEFAULT '{}',
  assignee text DEFAULT '',
  source text DEFAULT 'manual', source_detail text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
-- 不少链路按 lower(email) 匹配（收信挂链、回复匹配、agent 查人），UNIQUE 索引救不了表达式
CREATE INDEX IF NOT EXISTS idx_contacts_lower_email ON contacts(lower(email));
-- 联系人页/选人页高频查询路径：updated_at 排序、status/stage/client_type 筛选、company_id 关联
CREATE INDEX IF NOT EXISTS idx_contacts_updated_at ON contacts(updated_at);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_stage ON contacts(stage);
CREATE INDEX IF NOT EXISTS idx_contacts_client_type ON contacts(client_type);
CREATE INDEX IF NOT EXISTS idx_contacts_company_id ON contacts(company_id);
CREATE TABLE IF NOT EXISTS crm_relations (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  contact_id_a integer NOT NULL REFERENCES contacts(id),
  contact_id_b integer NOT NULL REFERENCES contacts(id),
  relation_type text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS crm_stages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  contact_id integer NOT NULL UNIQUE REFERENCES contacts(id),
  stage text NOT NULL, notes text,
  reminder_at text, reminder_note text,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox_messages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  account_id integer NOT NULL REFERENCES email_accounts(id),
  message_id text, from_email text NOT NULL, from_name text,
  subject text, body_preview text, classification text,
  "to" text, cc text, my_role text,
  matched_contact_id integer, related_contact_ids text,
  is_read integer DEFAULT 0 NOT NULL,
  received_at text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
-- 挂链回填（新建/导入联系人认领存量邮件）：只扫未认领行，表达式索引直接命中 lower(from_email)，
-- 否则每位联系人都全表扫一遍收件箱 —— 1500+ 导入时整程序冻死的根因
CREATE INDEX IF NOT EXISTS idx_inbox_unmatched_from ON inbox_messages(lower(from_email)) WHERE matched_contact_id IS NULL;
-- 客户详情「邮件往来」按 matched_contact_id 取数；回填后的事件补齐也走它
CREATE INDEX IF NOT EXISTS idx_inbox_matched ON inbox_messages(matched_contact_id);
CREATE TABLE IF NOT EXISTS interactions (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  contact_id integer NOT NULL REFERENCES contacts(id),
  type text NOT NULL, direction text NOT NULL,
  channel text DEFAULT 'email' NOT NULL,
  subject text, body_preview text, message_id text,
  account_id integer REFERENCES email_accounts(id),
  metadata text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox_bounce_matches (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  message_id integer NOT NULL, contact_id integer NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  UNIQUE(message_id, contact_id)
);
CREATE TABLE IF NOT EXISTS templates (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  name text NOT NULL, language text NOT NULL,
  subject text NOT NULL, body text NOT NULL,
  category text, stage text, version integer DEFAULT 1 NOT NULL,
  is_active integer DEFAULT 1 NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS send_queue (
  id text PRIMARY KEY NOT NULL,
  batch_id text NOT NULL,
  company_name text, company_id integer,
  recipients text NOT NULL,
  account_id integer NOT NULL, account_email text,
  subject text, tpl_body text, contact_vars text,
  cc text, tpl_name text, country text, language text,
  status text DEFAULT 'pending' NOT NULL,
  error text, sent_at text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_conversations (
  id text PRIMARY KEY NOT NULL,
  title text DEFAULT '新对话' NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_messages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  conversation_id text NOT NULL REFERENCES agent_conversations(id),
  role text NOT NULL, content text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  conversation_id text NOT NULL,
  tool_name text NOT NULL, side_effect text NOT NULL,
  args_json text, result_json text,
  approval text NOT NULL, error text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_gaps (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  wanted text NOT NULL, scene text, workaround text,
  hits integer DEFAULT 1 NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  last_seen_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_suggestions (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  day text NOT NULL, group_name text NOT NULL,
  template text NOT NULL, source text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_facts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  conversation_id text NOT NULL,
  tool_name text NOT NULL, fact text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_facts_conv ON agent_facts(conversation_id);
CREATE TABLE IF NOT EXISTS agent_working_memory (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  conversation_id text NOT NULL,
  kind text NOT NULL, ref_id text NOT NULL, tool_name text NOT NULL,
  context_line text NOT NULL, payload_json text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_awm_conv_kind ON agent_working_memory(conversation_id, kind);
CREATE TABLE IF NOT EXISTS send_campaigns (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  status text DEFAULT 'running' NOT NULL,
  auto_send integer DEFAULT 1 NOT NULL,
  target_filter_json text DEFAULT '{}' NOT NULL,
  touch_plan_json text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS send_campaign_targets (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  campaign_id text NOT NULL,
  contact_id integer NOT NULL,
  status text DEFAULT 'pending' NOT NULL,
  round integer DEFAULT 0 NOT NULL,
  next_touch_at text,
  last_sent_at text,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sct_campaign_status ON send_campaign_targets(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_sct_status_next ON send_campaign_targets(status, next_touch_at);
CREATE INDEX IF NOT EXISTS idx_sct_campaign_contact ON send_campaign_targets(campaign_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_agent_suggestions_day ON agent_suggestions(day);
CREATE INDEX IF NOT EXISTS idx_interactions_contact_id ON interactions(contact_id);
CREATE INDEX IF NOT EXISTS idx_interactions_type ON interactions(type);
CREATE INDEX IF NOT EXISTS idx_interactions_created_at ON interactions(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_messages_conv ON agent_messages(conversation_id);
CREATE TABLE IF NOT EXISTS rate_quotes (
  record_id text PRIMARY KEY NOT NULL,
  pol text, pod_raw text NOT NULL,
  lane text, carrier text,
  container text, container_raw text,
  ocean_usd integer,
  validity_raw text, valid_from text, valid_to text,
  free_days text, shortfall_fee text, note text,
  source_group text, sender text, msg_time text, image_name text,
  etd text, status text, message_text text,
  synced_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_quotes_lane ON rate_quotes(lane);
CREATE INDEX IF NOT EXISTS idx_rate_quotes_valid_to ON rate_quotes(valid_to);
/* 舱位镜像（同台账 /api/space）：群内动态，按 msg_time 看时效，不设有效期列 */
CREATE TABLE IF NOT EXISTS space_records (
  record_id text PRIMARY KEY NOT NULL,
  pol text, pod_raw text,
  lane text, carrier text,
  container text, container_raw text, box_qty text,
  space_type text, vessel text, etd text, cutoff_raw text,
  price_usd text, note text,
  source_group text, sender text, msg_time text, image_name text, status text,
  synced_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_space_records_lane ON space_records(lane);
CREATE INDEX IF NOT EXISTS idx_space_records_pod_raw ON space_records(pod_raw);
CREATE INDEX IF NOT EXISTS idx_space_records_msg_time ON space_records(msg_time);
`.trim();
