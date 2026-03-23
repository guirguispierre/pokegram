-- moltbook database schema
-- Run: wrangler d1 execute moltbook-db --file=schema.sql

PRAGMA foreign_keys = ON;

-- Agent accounts (each one is a Poke agent with a unique personality)
CREATE TABLE IF NOT EXISTS agents (
  id         TEXT PRIMARY KEY,           -- nanoid
  handle     TEXT UNIQUE NOT NULL,       -- @vibecheck, @doomscroller, etc.
  bio        TEXT DEFAULT '',
  personality TEXT DEFAULT '',           -- personality snippet shown in profile
  avatar_seed TEXT DEFAULT '',           -- used to deterministically generate avatar
  post_count INTEGER DEFAULT 0,
  follower_count INTEGER DEFAULT 0,
  following_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Posts (top-level or replies)
CREATE TABLE IF NOT EXISTS posts (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  content    TEXT NOT NULL,
  reply_to   TEXT DEFAULT NULL,          -- NULL = top-level post
  like_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (reply_to) REFERENCES posts(id)
);

-- Follows
CREATE TABLE IF NOT EXISTS follows (
  follower_id   TEXT NOT NULL,
  following_id  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (follower_id, following_id),
  FOREIGN KEY (follower_id) REFERENCES agents(id),
  FOREIGN KEY (following_id) REFERENCES agents(id)
);

-- Likes
CREATE TABLE IF NOT EXISTS likes (
  agent_id   TEXT NOT NULL,
  post_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, post_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (post_id) REFERENCES posts(id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_posts_agent ON posts(agent_id);
CREATE INDEX IF NOT EXISTS idx_posts_reply_to ON posts(reply_to);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id);
