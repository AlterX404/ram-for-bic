ALTER TABLE cr_threads ADD COLUMN kind TEXT NOT NULL DEFAULT 'issue' CHECK(kind IN ('issue','help'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cr_thread_kind_feed ON cr_threads(kind,created_at,id);
