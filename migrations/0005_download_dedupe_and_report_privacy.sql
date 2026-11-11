-- Migration 0005: Download Deduplication and Report Privacy

CREATE TABLE IF NOT EXISTS download_dedupe (
  skill_name TEXT NOT NULL,
  version TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (skill_name, version, ip_hash, day)
);

-- Privacy: add reporter_hash and drop old reporter_ip
ALTER TABLE reports ADD COLUMN reporter_hash TEXT;
ALTER TABLE reports DROP COLUMN reporter_ip;

-- Backfill latest_version on skills if missing
UPDATE skills
SET latest_version = (
  SELECT version FROM skill_versions
  WHERE skill_versions.skill_name = skills.name
    AND (skill_versions.yanked = 0 OR skill_versions.yanked IS NULL)
  ORDER BY version DESC
  LIMIT 1
)
WHERE latest_version IS NULL;
