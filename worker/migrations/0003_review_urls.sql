-- Libre — linkable TMDB reviews (review ids for /review/<id> deep links).
ALTER TABLE title_reviews ADD COLUMN tmdb_review_id TEXT;
