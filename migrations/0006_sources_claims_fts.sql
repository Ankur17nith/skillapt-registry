-- 0006_sources_claims_fts.sql: crawled/published sources, ownership claims, full-text search

-- Where a listing came from and who owns it.
--   source:       'published' (uploaded via the CLI) | 'crawled' (indexed from a public repo)
--   claim_status: 'owned' (publisher owns it) | 'unclaimed' (crawled, system-owned) | 'claimed' (crawled, owner verified)
ALTER TABLE skills ADD COLUMN source TEXT NOT NULL DEFAULT 'published';
ALTER TABLE skills ADD COLUMN claim_status TEXT NOT NULL DEFAULT 'owned';
ALTER TABLE skills ADD COLUMN source_url TEXT;
ALTER TABLE skills ADD COLUMN source_path TEXT;
ALTER TABLE skills ADD COLUMN source_sha TEXT;
ALTER TABLE skills ADD COLUMN source_owner TEXT;
ALTER TABLE skills ADD COLUMN crawled_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_source_key
  ON skills(source_url, source_path) WHERE source_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_skills_claim_status ON skills(claim_status);
CREATE INDEX IF NOT EXISTS idx_skills_source_owner ON skills(source_owner);

-- Ownership claims: a signed-in GitHub user asks to take over a crawled listing.
CREATE TABLE IF NOT EXISTS skill_claims (
  id TEXT PRIMARY KEY,
  skill_name TEXT NOT NULL REFERENCES skills(name) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  method TEXT NOT NULL,          -- 'github-owner' (repo owner matches handle)
  status TEXT NOT NULL,          -- 'approved' | 'rejected'
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_claims_skill ON skill_claims(skill_name);

-- System user that owns crawled listings until they are claimed.
INSERT OR IGNORE INTO users (id, github_id, handle, name, email, avatar_url, created_at, updated_at)
VALUES ('usr_crawler', -1, 'skillapt-crawler', 'Skillapt Crawler', NULL, '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

-- Full-text search over name, description and keywords (external-content FTS5).
-- The update trigger fires only when searchable columns change, so download
-- counter updates do not rewrite the index.
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  name, description, keywords,
  content='skills', content_rowid='rowid', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS skills_fts_ai AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(rowid, name, description, keywords)
  VALUES (new.rowid, new.name, new.description, new.keywords);
END;
CREATE TRIGGER IF NOT EXISTS skills_fts_ad AFTER DELETE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, keywords)
  VALUES ('delete', old.rowid, old.name, old.description, old.keywords);
END;
CREATE TRIGGER IF NOT EXISTS skills_fts_au AFTER UPDATE OF name, description, keywords ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, keywords)
  VALUES ('delete', old.rowid, old.name, old.description, old.keywords);
  INSERT INTO skills_fts(rowid, name, description, keywords)
  VALUES (new.rowid, new.name, new.description, new.keywords);
END;

INSERT INTO skills_fts(skills_fts) VALUES ('rebuild');
