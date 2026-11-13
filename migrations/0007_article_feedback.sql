ALTER TABLE articles ADD COLUMN rating TEXT CHECK (rating IN ('up','down'));
ALTER TABLE articles ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0,1));
CREATE INDEX articles_favorite_created ON articles(favorite, created_at DESC, id DESC);
