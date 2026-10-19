-- A chosen GitHub filename survives failed writes and Worker restarts. The
-- confirmed content hash/time remains in article_github_backups.
CREATE TABLE article_github_backup_paths (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  repository TEXT NOT NULL,
  branch TEXT NOT NULL,
  folder TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (article_id, repository, branch, folder),
  UNIQUE (repository, branch, path)
);

CREATE INDEX article_github_backup_paths_destination
  ON article_github_backup_paths(repository, branch, folder, path);

-- Keep existing confirmed filenames as reservations. The recursive splitter
-- derives each path's parent without assuming a configured folder name.
WITH RECURSIVE path_parts(article_id, repository, branch, path, remainder, folder) AS (
  SELECT article_id, repository, branch, path, path, ''
  FROM article_github_backups
  UNION ALL
  SELECT article_id, repository, branch, path,
         substr(remainder, instr(remainder, '/') + 1),
         folder || substr(remainder, 1, instr(remainder, '/'))
  FROM path_parts
  WHERE instr(remainder, '/') > 0
)
INSERT OR IGNORE INTO article_github_backup_paths (article_id, repository, branch, folder, path)
SELECT article_id, repository, branch, rtrim(folder, '/'), path
FROM path_parts
WHERE instr(remainder, '/') = 0
  AND 1 = (SELECT count(*) FROM article_github_backups duplicate
           WHERE duplicate.repository = path_parts.repository
             AND duplicate.branch = path_parts.branch
             AND duplicate.path = path_parts.path);
