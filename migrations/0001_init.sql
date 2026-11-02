CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  owner_chat_id TEXT NOT NULL,
  week_number INTEGER,
  status TEXT NOT NULL CHECK (status IN ('awaiting_week', 'collecting', 'ready', 'publishing', 'publish_failed', 'completed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_owner_status
  ON sessions(owner_id, status, id DESC);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  source_chat_id TEXT NOT NULL,
  source_message_id INTEGER NOT NULL,
  file_id TEXT,
  file_unique_id TEXT,
  file_name TEXT,
  media_kind TEXT NOT NULL DEFAULT 'text',
  display_name TEXT NOT NULL,
  group_type TEXT NOT NULL CHECK (group_type IN ('lectures', 'sections', 'summaries')),
  subject_code TEXT,
  is_audio INTEGER NOT NULL DEFAULT 0,
  section_number INTEGER,
  lecture_number INTEGER,
  is_answer INTEGER NOT NULL DEFAULT 0,
  received_order INTEGER NOT NULL,
  classification_status TEXT NOT NULL DEFAULT 'auto' CHECK (classification_status IN ('auto', 'manual', 'review')),
  ignored INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  UNIQUE(session_id, source_chat_id, source_message_id)
);

CREATE INDEX IF NOT EXISTS idx_items_session_group_subject
  ON items(session_id, group_type, subject_code, ignored);
CREATE INDEX IF NOT EXISTS idx_items_session_review
  ON items(session_id, classification_status, ignored);
CREATE INDEX IF NOT EXISTS idx_items_session_unique_file
  ON items(session_id, file_unique_id);

CREATE TABLE IF NOT EXISTS publish_plan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  sequence_no INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'copy')),
  group_type TEXT NOT NULL,
  text_content TEXT,
  item_id INTEGER,
  add_hashtag INTEGER NOT NULL DEFAULT 0,
  subject_code TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  telegram_message_id INTEGER,
  last_error TEXT,
  attempted_at TEXT,
  sent_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE SET NULL,
  UNIQUE(session_id, sequence_no)
);

CREATE INDEX IF NOT EXISTS idx_plan_session_status_sequence
  ON publish_plan(session_id, status, sequence_no);

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
