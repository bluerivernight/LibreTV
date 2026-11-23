-- Libre — title enrichment for cinematic detail + person pages (TMDB metadata only).
-- SQLite-compatible syntax. All ids are application-generated TEXT.

-- people — one row per TMDB person (id tmdb-person-<tmdbId>).
CREATE TABLE IF NOT EXISTS people (
  id          TEXT PRIMARY KEY,
  tmdb_id     INTEGER NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  photo_path  TEXT,                        -- TMDB profile path (e.g. "/abc.jpg"), NULL when unknown
  department  TEXT,                        -- known_for_department ("Acting", "Directing", …)
  birthday    TEXT,                        -- ISO date as TEXT
  birthplace  TEXT,
  bio         TEXT,
  imdb_id     TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- cast_members — top-billed cast per series (movies: film cast; tv: series cast).
CREATE TABLE IF NOT EXISTS cast_members (
  id             TEXT PRIMARY KEY,
  series_id      TEXT NOT NULL,
  person_id      TEXT NOT NULL,
  character_name TEXT,
  cast_order     INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE,
  UNIQUE (series_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_cast_series ON cast_members(series_id);
CREATE INDEX IF NOT EXISTS idx_cast_person ON cast_members(person_id);

-- title_reviews — excerpts from TMDB member reviews.
CREATE TABLE IF NOT EXISTS title_reviews (
  id         TEXT PRIMARY KEY,
  series_id  TEXT NOT NULL,
  author     TEXT NOT NULL,
  rating     REAL,                          -- author_details.rating (0-10), NULL when unrated
  content    TEXT NOT NULL,
  created_at TEXT,                          -- TMDB created_at as TEXT
  FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reviews_series ON title_reviews(series_id);

-- similar_titles — TMDB recommendations (ranked). Rows may point at series
-- that are NOT in the catalog; the API only returns matches that exist.
CREATE TABLE IF NOT EXISTS similar_titles (
  series_id         TEXT NOT NULL,
  similar_series_id TEXT NOT NULL,
  rank              INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (series_id, similar_series_id),
  FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_similar_series ON similar_titles(series_id);

-- title_videos — trailer pick per series (YouTube only).
CREATE TABLE IF NOT EXISTS title_videos (
  id        TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  site      TEXT NOT NULL,                 -- 'YouTube'
  video_key TEXT NOT NULL,                 -- YouTube video id
  kind      TEXT NOT NULL,                 -- 'Trailer' | 'Teaser'
  name      TEXT,
  FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
  UNIQUE (series_id)
);
