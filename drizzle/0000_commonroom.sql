CREATE TABLE IF NOT EXISTS cr_users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cr_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES cr_users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cr_rate (
  bucket TEXT PRIMARY KEY,
  start_at INTEGER NOT NULL,
  hits INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cr_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES cr_users(id),
  sample INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cr_members (
  server_id TEXT NOT NULL REFERENCES cr_servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES cr_users(id),
  role TEXT NOT NULL CHECK(role IN ('owner','moderator','member')),
  PRIMARY KEY (server_id,user_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cr_member_user ON cr_members(user_id,server_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cr_invites (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES cr_servers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cr_categories (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES cr_servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  UNIQUE(id,server_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cr_channels (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  name TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  role_mask INTEGER NOT NULL CHECK(role_mask IN (4,5,6,7)),
  position INTEGER NOT NULL,
  FOREIGN KEY(category_id,server_id) REFERENCES cr_categories(id,server_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cr_channel_order ON cr_channels(server_id,category_id,position);
--> statement-breakpoint
CREATE VIEW IF NOT EXISTS cr_access AS
SELECT c.id AS channel_id,c.server_id,m.user_id,m.role
  FROM cr_channels c JOIN cr_members m ON m.server_id=c.server_id
 WHERE (c.role_mask & CASE m.role WHEN 'owner' THEN 4 WHEN 'moderator' THEN 2 ELSE 1 END) != 0;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cr_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL REFERENCES cr_channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES cr_users(id),
  reply_to_id TEXT REFERENCES cr_messages(id),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cr_message_page ON cr_messages(channel_id,seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cr_message_rate ON cr_messages(author_id,created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cr_reactions (
  message_id TEXT NOT NULL REFERENCES cr_messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES cr_users(id),
  emoji TEXT NOT NULL,
  PRIMARY KEY (message_id,user_id,emoji)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cr_read_positions (
  channel_id TEXT NOT NULL REFERENCES cr_channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES cr_users(id),
  last_seq INTEGER NOT NULL,
  PRIMARY KEY(channel_id,user_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cr_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL REFERENCES cr_channels(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES cr_messages(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cr_change_page ON cr_changes(channel_id,seq);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cr_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES cr_servers(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES cr_users(id),
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cr_audit_page ON cr_audit(server_id,id);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS cr_message_added AFTER INSERT ON cr_messages BEGIN
  INSERT INTO cr_changes(channel_id,message_id) VALUES(NEW.channel_id,NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS cr_message_changed AFTER UPDATE ON cr_messages BEGIN
  INSERT INTO cr_changes(channel_id,message_id) VALUES(NEW.channel_id,NEW.id);
  INSERT INTO cr_changes(channel_id,message_id) SELECT channel_id,id FROM cr_messages WHERE reply_to_id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS cr_reaction_added AFTER INSERT ON cr_reactions BEGIN
  INSERT INTO cr_changes(channel_id,message_id) SELECT channel_id,id FROM cr_messages WHERE id=NEW.message_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS cr_reaction_removed AFTER DELETE ON cr_reactions BEGIN
  INSERT INTO cr_changes(channel_id,message_id) SELECT channel_id,id FROM cr_messages WHERE id=OLD.message_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS cr_owner_cannot_leave BEFORE DELETE ON cr_members
WHEN OLD.role='owner' BEGIN
  SELECT RAISE(ABORT,'Owner membership must be retained');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS cr_owner_cannot_demote BEFORE UPDATE OF role ON cr_members
WHEN OLD.role='owner' AND NEW.role!='owner' BEGIN
  SELECT RAISE(ABORT,'Owner role must be retained');
END;
