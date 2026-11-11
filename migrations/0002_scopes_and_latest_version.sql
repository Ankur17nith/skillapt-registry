-- 0002_scopes_and_latest_version.sql: Scopes ownership table and latest_version column

CREATE TABLE IF NOT EXISTS scopes (
  scope TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  github_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scopes_github_id ON scopes(github_id);

ALTER TABLE skills ADD COLUMN latest_version TEXT DEFAULT NULL;
