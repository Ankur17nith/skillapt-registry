-- 0004_auth_tokens_and_sessions.sql: Add expires_at to api_tokens, clear plaintext sessions for hash storage

ALTER TABLE api_tokens ADD COLUMN expires_at TEXT DEFAULT NULL;

-- Clear existing plaintext sessions; new sessions store sha256(sessionId)
DELETE FROM sessions;

CREATE INDEX IF NOT EXISTS idx_api_tokens_expires ON api_tokens(expires_at);
