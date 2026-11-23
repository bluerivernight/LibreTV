-- Libre — free legal live TV (official YouTube live streams only).
-- Channels are news networks publishing free 24/7 live streams on their own
-- official YouTube channels. Playback uses YouTube's own embed player, so the
-- owner keeps ads, branding and distribution control. No third-party
-- re-streams, no scraped HLS — if an owner disables embedding, YouTube itself
-- renders the notice in-frame.

CREATE TABLE IF NOT EXISTS live_channels (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  category           TEXT NOT NULL DEFAULT 'News',
  youtube_channel_id TEXT NOT NULL UNIQUE,
  sort               INTEGER NOT NULL DEFAULT 0
);

-- Seeded from verified official channels (Oct 2026):
--   Bloomberg Television  UCIALMKvObZNtJ6AmdCLP7Lg  (@markets, 3.28M subs, 24/7 live)
--   DW News               UCknLrEdhRCp1aegoMqRaCZg  (@dwnews)
--   Al Jazeera English    UCNye-wNBqNL5ZzHSJj3l8Bg  (@aljazeeraenglish)
--   FRANCE 24 English     UCQfwfsi5VrQ8yKZ-UWmAEFg  (@France24_en)
--   Sky News              UCoMdktPbSTixAyNGwb-UYkQ  (@SkyNews)
INSERT OR REPLACE INTO live_channels (id, name, category, youtube_channel_id, sort) VALUES
  ('live-bloomberg',  'Bloomberg Television', 'News', 'UCIALMKvObZNtJ6AmdCLP7Lg', 0),
  ('live-dw',         'DW News',              'News', 'UCknLrEdhRCp1aegoMqRaCZg', 1),
  ('live-aljazeera',  'Al Jazeera English',   'News', 'UCNye-wNBqNL5ZzHSJj3l8Bg', 2),
  ('live-france24',   'FRANCE 24 English',    'News', 'UCQfwfsi5VrQ8yKZ-UWmAEFg', 3),
  ('live-skynews',    'Sky News',             'News', 'UCoMdktPbSTixAyNGwb-UYkQ', 4);
