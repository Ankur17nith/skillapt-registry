-- 0001_initial.sql: Skillapt Registry Initial D1 Schema

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id INTEGER UNIQUE NOT NULL,
  handle TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  avatar_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  last_used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  description TEXT NOT NULL,
  license TEXT NOT NULL,
  repository TEXT,
  category TEXT NOT NULL,
  keywords TEXT NOT NULL,       -- JSON array of strings
  compatibility TEXT NOT NULL,  -- JSON array of strings
  downloads INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  readme TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY,
  skill_name TEXT NOT NULL REFERENCES skills(name) ON DELETE CASCADE,
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  tarball_path TEXT NOT NULL,
  yanked INTEGER NOT NULL DEFAULT 0,
  yank_reason TEXT,
  permissions TEXT NOT NULL,    -- JSON object: { network, shell, filesystem }
  published_by TEXT NOT NULL REFERENCES users(id),
  published_at TEXT NOT NULL,
  UNIQUE(skill_name, version)
);

CREATE TABLE IF NOT EXISTS dependencies (
  id TEXT PRIMARY KEY,
  skill_name TEXT NOT NULL,
  version TEXT NOT NULL,
  dep_name TEXT NOT NULL,
  dep_version_range TEXT NOT NULL,
  FOREIGN KEY (skill_name, version) REFERENCES skill_versions(skill_name, version) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  skill_name TEXT NOT NULL,
  version TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL,
  reporter_ip TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

-- Optimized Indexes
CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
CREATE INDEX IF NOT EXISTS idx_skills_downloads ON skills(downloads DESC);
CREATE INDEX IF NOT EXISTS idx_skills_updated ON skills(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions(skill_name);
CREATE INDEX IF NOT EXISTS idx_tokens_hash ON api_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_dependencies_skill ON dependencies(skill_name, version);
