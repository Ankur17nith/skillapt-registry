-- 0003_takedown_and_version_status.sql: Version status, takedown fields, user role, and audit log

ALTER TABLE skill_versions ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE skill_versions ADD COLUMN removal_reason TEXT DEFAULT NULL;
ALTER TABLE skill_versions ADD COLUMN removed_at TEXT DEFAULT NULL;

-- Backfill status from the existing yanked column
UPDATE skill_versions SET status = 'yanked' WHERE yanked = 1;

-- Add role to users table
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';

-- Create audit_log table
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
