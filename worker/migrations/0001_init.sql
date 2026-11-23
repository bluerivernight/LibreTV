-- Libre — D1 initialization (ARCHITECTURE.md §8.1 / §8.2).
-- SQLite-compatible syntax only: TEXT ids (application-generated), INTEGER unix-epoch
-- timestamps, JSON stored as TEXT. No PostgreSQL-only constructs.
-- This migration is the exact schema verified against SQLite 3.50.4 in Milestone 1.

-- users — application-generated TEXT ids; unix-epoch INTEGER timestamps.
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  display_name    TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  is_admin        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- sessions — opaque random id; store the hash server-side.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,          -- sha256(raw_session_token) hex
  user_id     TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  user_agent  TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- series -> seasons -> episodes
CREATE TABLE IF NOT EXISTS series (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  overview    TEXT,
  metadata_json TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS seasons (
  id          TEXT PRIMARY KEY,
  series_id   TEXT NOT NULL,
  season_num  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
  UNIQUE (series_id, season_num)
);

CREATE TABLE IF NOT EXISTS episodes (
  id              TEXT PRIMARY KEY,
  season_id       TEXT NOT NULL,
  episode_num     INTEGER NOT NULL,
  title           TEXT NOT NULL,
  overview        TEXT,
  release_date    TEXT,                  -- ISO date as TEXT
  runtime_minutes INTEGER,
  metadata_json   TEXT,                  -- JSON as TEXT
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE,
  UNIQUE (season_id, episode_num)
);

-- assets — canonical media identity via storage_key (no permanent public URLs)
CREATE TABLE IF NOT EXISTS assets (
  id             TEXT PRIMARY KEY,
  episode_id     TEXT NOT NULL,
  storage_key    TEXT NOT NULL,          -- e.g. "media/<assetId>/playlist.m3u8"
  media_type     TEXT NOT NULL,          -- 'hls' | 'mp4' | 'image' | 'subtitle'
  rendition      TEXT,                   -- 'source' | '720p' | '480p' | ... (NULL for images/subtitles)
  container      TEXT,                   -- 'ts' (MPEG-TS segments) or 'mp4'
  codecs_json    TEXT,                   -- JSON as TEXT (video/audio codec metadata)
  byte_size      INTEGER,
  duration_seconds REAL,
  is_enabled     INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_assets_episode     ON assets(episode_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_key  ON assets(storage_key);

-- subtitles
CREATE TABLE IF NOT EXISTS subtitles (
  id         TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  language   TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_subtitles_episode ON subtitles(episode_id);

-- rights — neutral entitlement grants. user_id NULL = global/free entitlement.
CREATE TABLE IF NOT EXISTS rights (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,                      -- NULL = applies to all users
  episode_id  TEXT,
  access_type TEXT NOT NULL,             -- 'free' | 'premium' (neutral licensing label)
  expires_at  INTEGER,                   -- NULL = no expiry
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rights_user    ON rights(user_id);
CREATE INDEX IF NOT EXISTS idx_rights_episode ON rights(episode_id);

-- progress
CREATE TABLE IF NOT EXISTS progress (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  episode_id       TEXT NOT NULL,
  position_seconds REAL NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE,
  UNIQUE (user_id, episode_id)
);

-- bookmarks
CREATE TABLE IF NOT EXISTS bookmarks (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE,
  UNIQUE (user_id, episode_id)
);

-- §8.2 Search (MVP): SQLite FTS5.
-- Normal (non-contentless) FTS5 table: keep in sync via rowid-mirrored inserts and
-- plain `DELETE ... WHERE rowid` (sqlite.org/fts5.html §6.3 — the special 'delete'
-- command does NOT apply to normal FTS5 tables). Verified against SQLite 3.50.4 in M1.
CREATE VIRTUAL TABLE IF NOT EXISTS episode_fts USING fts5(
  episode_id UNINDEXED,
  title,
  overview
);

CREATE TRIGGER IF NOT EXISTS episode_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episode_fts(rowid, episode_id, title, overview) VALUES (new.rowid, new.id, new.title, new.overview);
END;
CREATE TRIGGER IF NOT EXISTS episode_ad AFTER DELETE ON episodes BEGIN
  DELETE FROM episode_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS episode_au AFTER UPDATE ON episodes BEGIN
  DELETE FROM episode_fts WHERE rowid = old.rowid;
  INSERT INTO episode_fts(rowid, episode_id, title, overview) VALUES (new.rowid, new.id, new.title, new.overview);
END;