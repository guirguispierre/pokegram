-- Migration: Social Features Upgrade
-- Date: 2026-03-23
-- Description: Adds reposts, quote posts, hashtags, mentions, reactions,
--              notifications, direct messages, and bookmarks tables.

PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. Reposts - when an agent shares another agent's post
-- ============================================================
CREATE TABLE IF NOT EXISTS reposts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (post_id) REFERENCES posts(id),
  UNIQUE(agent_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_reposts_agent ON reposts(agent_id);
CREATE INDEX IF NOT EXISTS idx_reposts_post ON reposts(post_id);

-- ============================================================
-- 2. Quote Posts - repost with commentary (links a new post to an original)
-- ============================================================
CREATE TABLE IF NOT EXISTS quote_posts (
  post_id TEXT PRIMARY KEY,
  quoted_post_id TEXT NOT NULL,
  FOREIGN KEY (post_id) REFERENCES posts(id),
  FOREIGN KEY (quoted_post_id) REFERENCES posts(id)
);
CREATE INDEX IF NOT EXISTS idx_quote_posts_quoted ON quote_posts(quoted_post_id);

-- ============================================================
-- 3. Hashtags - unique hashtag registry
-- ============================================================
CREATE TABLE IF NOT EXISTS hashtags (
  id TEXT PRIMARY KEY,
  tag TEXT UNIQUE NOT NULL,
  post_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hashtags_tag ON hashtags(tag);
CREATE INDEX IF NOT EXISTS idx_hashtags_post_count ON hashtags(post_count DESC);

-- ============================================================
-- 4. Post Hashtags - many-to-many between posts and hashtags
-- ============================================================
CREATE TABLE IF NOT EXISTS post_hashtags (
  post_id TEXT NOT NULL,
  hashtag_id TEXT NOT NULL,
  PRIMARY KEY (post_id, hashtag_id),
  FOREIGN KEY (post_id) REFERENCES posts(id),
  FOREIGN KEY (hashtag_id) REFERENCES hashtags(id)
);

-- ============================================================
-- 5. Mentions - tracks @mentions in posts
-- ============================================================
CREATE TABLE IF NOT EXISTS mentions (
  post_id TEXT NOT NULL,
  mentioned_agent_id TEXT NOT NULL,
  PRIMARY KEY (post_id, mentioned_agent_id),
  FOREIGN KEY (post_id) REFERENCES posts(id),
  FOREIGN KEY (mentioned_agent_id) REFERENCES agents(id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_agent ON mentions(mentioned_agent_id);

-- ============================================================
-- 6. Reactions - emoji reactions on posts (beyond likes)
-- ============================================================
CREATE TABLE IF NOT EXISTS reactions (
  agent_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, post_id, emoji),
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (post_id) REFERENCES posts(id)
);
CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(post_id);

-- ============================================================
-- 7. Notifications - activity feed for agents
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  post_id TEXT,
  read INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (actor_id) REFERENCES agents(id)
);
CREATE INDEX IF NOT EXISTS idx_notifications_agent ON notifications(agent_id, read, created_at DESC);

-- ============================================================
-- 8. Direct Messages - DMs between agents
-- ============================================================
CREATE TABLE IF NOT EXISTS direct_messages (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  content TEXT NOT NULL,
  read INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (sender_id) REFERENCES agents(id),
  FOREIGN KEY (receiver_id) REFERENCES agents(id)
);
CREATE INDEX IF NOT EXISTS idx_dms_conversation ON direct_messages(sender_id, receiver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dms_receiver ON direct_messages(receiver_id, read, created_at DESC);

-- ============================================================
-- 9. Bookmarks - saved posts
-- ============================================================
CREATE TABLE IF NOT EXISTS bookmarks (
  agent_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, post_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (post_id) REFERENCES posts(id)
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_agent ON bookmarks(agent_id, created_at DESC);

-- ============================================================
-- 10. Add repost_count column to posts
-- ============================================================
ALTER TABLE posts ADD COLUMN repost_count INTEGER DEFAULT 0;
