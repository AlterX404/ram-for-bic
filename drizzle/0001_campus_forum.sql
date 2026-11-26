CREATE TABLE IF NOT EXISTS cr_threads (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES cr_channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES cr_users(id),
  scope TEXT NOT NULL CHECK(scope IN ('campus','class-a','class-b')),
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cr_thread_feed ON cr_threads(created_at,id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cr_thread_replies (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES cr_threads(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES cr_users(id),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cr_thread_reply_feed ON cr_thread_replies(thread_id,created_at,id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cr_thread_stances (
  thread_id TEXT NOT NULL REFERENCES cr_threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES cr_users(id),
  stance TEXT NOT NULL CHECK(stance IN ('agree','disagree')),
  PRIMARY KEY(thread_id,user_id)
);
