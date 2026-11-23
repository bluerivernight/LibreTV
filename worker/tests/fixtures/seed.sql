-- Libre — demo/seed catalog for tests and local dev (dev-only, test content).
-- Mirrors the layout produced by ingest/ingest.sh for media/<assetId>/…
-- Password of demo@libre.tv / demo-pass-2026 (PBKDF2-SHA256, 210000 iters) —
-- the hash string is deterministic and statically validated in unit tests.

INSERT OR REPLACE INTO users (id, email, password_hash, display_name, is_active, is_admin, created_at, updated_at)
VALUES (
  'usr_demo',
  'demo@libre.tv',
  'pbkdf2$sha256$210000$97VlTdYCUQV0PKi2SHhoGQ$MEPDgD5brbajSMc4IkaOwLd6eR7X0WaB-r0Z43xh3K0',
  'Demo',
  1,
  0,
  1700000000,
  1700000000
);

-- Series 1 — free global entitlement (Big Buck Bunny, Blender Foundation, CC-BY test content).
INSERT OR REPLACE INTO series (id, name, overview, metadata_json, created_at, updated_at)
VALUES ('srl_bbb', 'Big Buck Bunny', 'Open test content, HLS ABR ladder.',
        '{"poster":"images/bbb/poster.jpg","fanart":"images/bbb/fanart.jpg"}',
        1700000000, 1700000000);

INSERT OR REPLACE INTO seasons (id, series_id, season_num, created_at)
VALUES ('sea_bbb_1', 'srl_bbb', 1, 1700000000);

INSERT OR REPLACE INTO episodes (id, season_id, episode_num, title, overview, release_date, runtime_minutes, metadata_json, created_at, updated_at)
VALUES ('ep_bbb_01', 'sea_bbb_1', 1, 'Sintel Trailer', 'Short ADR ladder for engine tests.', '2008-01-01', 1,
        '{"source":"bigbuckbunny.org","license":"CC-BY","still":"images/bbb/still1.jpg"}', 1700000000, 1700000000);

-- Episode 2 — free only to the demo user (exercises per-user rights + limitation surface).
INSERT OR REPLACE INTO episodes (id, season_id, episode_num, title, overview, release_date, runtime_minutes, metadata_json, created_at, updated_at)
VALUES ('ep_bbb_02', 'sea_bbb_1', 2, 'Per-User Clip', 'Granted only to demo@libre.tv (per-user rights row).', '2008-01-02', 1,
        '{"source":"bigbuckbunny.org","license":"CC-BY"}', 1700000000, 1700000000);

-- Series 2 — no grants at all (limitations surface for everyone).
INSERT OR REPLACE INTO series (id, name, overview, metadata_json, created_at, updated_at)
VALUES ('srl_gated', 'Gated Test', 'No rights rows: playability must surface as a limitation.',
        '{"poster":"images/gated/poster.jpg","fanart":"images/gated/fanart.jpg"}', 1700000000, 1700000000);

INSERT OR REPLACE INTO seasons (id, series_id, season_num, created_at)
VALUES ('sea_gated_1', 'srl_gated', 1, 1700000000);

INSERT OR REPLACE INTO episodes (id, season_id, episode_num, title, overview, release_date, runtime_minutes, metadata_json, created_at, updated_at)
VALUES ('ep_gated_01', 'sea_gated_1', 1, 'Paywalled', 'No entitlement rows exist for this episode.', '2024-01-01', 1,
        '{"note":"deny-by-default"}', 1700000000, 1700000000);

-- Assets — canonical storage_key identity (§9.1). One master + one row per rendition.
INSERT OR REPLACE INTO assets (id, episode_id, storage_key, media_type, rendition, container, codecs_json, byte_size, duration_seconds, is_enabled, created_at)
VALUES
  ('ast_bbb_01_master', 'ep_bbb_01', 'media/bbb01/master.m3u8',        'hls', NULL,      NULL,  '{"generator":"ffmpeg-9"}', 512,   NULL,        1, 1700000000),
  ('ast_bbb_01_720p',   'ep_bbb_01', 'media/bbb01/720p/playlist.m3u8', 'hls', '720p',    'ts',  '{"generator":"ffmpeg-9"}', 4096,  2.0,         1, 1700000000),
  ('ast_bbb_01_480p',   'ep_bbb_01', 'media/bbb01/480p/playlist.m3u8', 'hls', '480p',    'ts',  '{"generator":"ffmpeg-9"}', 4096,  2.0,         1, 1700000000),
  ('ast_bbb_02_master', 'ep_bbb_02', 'media/bbb02/master.m3u8',        'hls', NULL,      NULL,  '{"generator":"ffmpeg-9"}', 512,   NULL,        1, 1700000000),
  ('ast_bbb_02_720p',   'ep_bbb_02', 'media/bbb02/720p/playlist.m3u8', 'hls', '720p',    'ts',  '{"generator":"ffmpeg-9"}', 4096,  2.0,         1, 1700000000),
  ('ast_gated_01_master','ep_gated_01','media/gated01/master.m3u8',    'hls', NULL,      NULL,  '{"generator":"ffmpeg-9"}', 512,   NULL,        1, 1700000000),
  ('ast_gated_01_720p', 'ep_gated_01', 'media/gated01/720p/playlist.m3u8', 'hls', '720p', 'ts',  '{"generator":"ffmpeg-9"}', 4096,  2.0,        1, 1700000000);

-- Rights — neutral entitlements (§8). user_id NULL = global/free.
INSERT OR REPLACE INTO rights (id, user_id, episode_id, access_type, expires_at, created_at)
VALUES
  ('rgt_bbb_01_global', NULL,      'ep_bbb_01', 'free',    NULL,       1700000000),
  ('rgt_bbb_02_demo',   'usr_demo', 'ep_bbb_02', 'free',    NULL,       1700000000);
-- ep_gated_01 deliberately has NO rights row.

-- Title enrichment (migration 0002 tables): cast, review, similar, trailer.
UPDATE series SET metadata_json = '{"poster":"images/bbb/poster.jpg","fanart":"images/bbb/fanart.jpg","logo":"images/bbb/logo.png","kind":"movie","tagline":"Small hero, big adventure.","year":2008,"runtime_minutes":10,"imdb_id":"tt1254207","score":7.8,"popularity":42.5,"genres":["Animation","Comedy"]}' WHERE id = 'srl_bbb';

INSERT OR REPLACE INTO people (id, tmdb_id, name, photo_path, department, birthday, birthplace, bio, imdb_id, created_at, updated_at)
VALUES ('tmdb-person-1', 1, 'Test Actor', '/actor.jpg', 'Acting', '1970-01-01', 'Test City, TC', 'A test actor biography.', 'nm0000001', 1700000000, 1700000000);

INSERT OR REPLACE INTO cast_members (id, series_id, person_id, character_name, cast_order)
VALUES ('cast_bbb_1', 'srl_bbb', 'tmdb-person-1', 'Hero (voice)', 0);

INSERT OR REPLACE INTO title_reviews (id, series_id, author, rating, content, created_at, tmdb_review_id)
VALUES ('rev_bbb_1', 'srl_bbb', 'reviewer1', 9.0, 'A lovely open movie with great spirit and craft.', '2024-01-01', 'tmdbrev1');

INSERT OR REPLACE INTO similar_titles (series_id, similar_series_id, rank)
VALUES ('srl_bbb', 'srl_gated', 0);

INSERT OR REPLACE INTO title_videos (id, series_id, site, video_key, kind, name)
VALUES ('vid_bbb_1', 'srl_bbb', 'YouTube', 'dQw4w9WgXcQ', 'Trailer', 'Official Trailer');

-- Series 3 — TMDB-backed (exercises resolve + watch_url; no assets/rights).
INSERT OR REPLACE INTO series (id, name, overview, metadata_json, created_at, updated_at)
VALUES ('srl_tmdb', 'TMDB Test Film', 'Carries a TMDB id for watch URLs.',
        '{"tmdb_id":424242,"kind":"movie","poster":"images/tmdb/poster.jpg","score":7.1,"genres":["Drama"],"year":2020,"popularity":5.0}',
        1700000000, 1700000000);

INSERT OR REPLACE INTO seasons (id, series_id, season_num, created_at)
VALUES ('sea_tmdb_1', 'srl_tmdb', 1, 1700000000);

INSERT OR REPLACE INTO episodes (id, season_id, episode_num, title, overview, release_date, runtime_minutes, metadata_json, created_at, updated_at)
VALUES ('ep_tmdb_01', 'sea_tmdb_1', 1, 'TMDB Test Film', 'Single-episode film.', '2020-01-01', 90,
        NULL, 1700000000, 1700000000);