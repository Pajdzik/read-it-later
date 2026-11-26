ALTER TABLE article_copies ADD COLUMN podcast_suitability TEXT;
CREATE INDEX article_copies_pending_podcast_fit
  ON article_copies(article_id) WHERE podcast_suitability IS NULL;

CREATE TRIGGER podcast_fit_copy_changed AFTER UPDATE OF revision ON article_copies
  WHEN NEW.revision IS NOT OLD.revision AND NEW.podcast_suitability IS NOT NULL
BEGIN
  UPDATE article_copies SET podcast_suitability=NULL WHERE article_id=NEW.article_id;
END;

CREATE TRIGGER podcast_fit_title_changed AFTER UPDATE OF title ON articles
  WHEN NEW.title IS NOT OLD.title
BEGIN
  UPDATE article_copies SET podcast_suitability=NULL
    WHERE article_id=NEW.id AND podcast_suitability IS NOT NULL;
END;
