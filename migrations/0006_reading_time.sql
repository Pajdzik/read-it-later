ALTER TABLE article_copies ADD COLUMN reading_time_minutes INTEGER
  CHECK (reading_time_minutes IS NULL OR (typeof(reading_time_minutes)='integer' AND reading_time_minutes > 0));
ALTER TABLE article_capture_recovery ADD COLUMN reading_time_minutes INTEGER
  CHECK (reading_time_minutes IS NULL OR (typeof(reading_time_minutes)='integer' AND reading_time_minutes > 0));
