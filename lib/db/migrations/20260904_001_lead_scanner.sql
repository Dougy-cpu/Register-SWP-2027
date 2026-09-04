BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  CREATE TYPE sponsor_lead_scan_source AS ENUM ('camera', 'image', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE attendees
  ADD COLUMN IF NOT EXISTS lead_sharing_excluded BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE attendees
  ADD COLUMN IF NOT EXISTS lead_sharing_notice_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS attendee_badges (
  id SERIAL PRIMARY KEY,
  attendee_id INTEGER NOT NULL REFERENCES attendees(id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (code ~ '^[0-9A-F]{12}$'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS attendee_badges_attendee_uniq
  ON attendee_badges (attendee_id);
CREATE UNIQUE INDEX IF NOT EXISTS attendee_badges_code_uniq
  ON attendee_badges (code);
CREATE INDEX IF NOT EXISTS attendee_badges_active_idx
  ON attendee_badges (active, updated_at DESC);

CREATE TABLE IF NOT EXISTS sponsor_scanner_devices (
  id TEXT PRIMARY KEY,
  sponsor_id INTEGER NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  access_version INTEGER NOT NULL CHECK (access_version >= 1),
  token_hash TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  user_agent TEXT,
  pack_version TEXT,
  camera_tested BOOLEAN NOT NULL DEFAULT FALSE,
  qr_tested BOOLEAN NOT NULL DEFAULT FALSE,
  storage_tested BOOLEAN NOT NULL DEFAULT FALSE,
  offline_tested BOOLEAN NOT NULL DEFAULT FALSE,
  sync_tested BOOLEAN NOT NULL DEFAULT FALSE,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_scanner_devices_token_hash_uniq
  ON sponsor_scanner_devices (token_hash);
CREATE INDEX IF NOT EXISTS sponsor_scanner_devices_sponsor_idx
  ON sponsor_scanner_devices (sponsor_id, revoked_at, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS sponsor_leads (
  id TEXT PRIMARY KEY,
  sponsor_id INTEGER NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  attendee_id INTEGER NOT NULL REFERENCES attendees(id) ON DELETE RESTRICT,
  rating INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
  scan_count INTEGER NOT NULL DEFAULT 0 CHECK (scan_count >= 0),
  first_scanned_at TIMESTAMPTZ,
  last_scanned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_leads_sponsor_attendee_uniq
  ON sponsor_leads (sponsor_id, attendee_id);
CREATE INDEX IF NOT EXISTS sponsor_leads_sponsor_recent_idx
  ON sponsor_leads (sponsor_id, last_scanned_at DESC);

CREATE TABLE IF NOT EXISTS sponsor_lead_scan_events (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES sponsor_leads(id) ON DELETE CASCADE,
  sponsor_id INTEGER NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  attendee_id INTEGER NOT NULL REFERENCES attendees(id) ON DELETE RESTRICT,
  scanner_device_id TEXT NOT NULL REFERENCES sponsor_scanner_devices(id) ON DELETE RESTRICT,
  operator_name TEXT NOT NULL,
  badge_version INTEGER NOT NULL CHECK (badge_version >= 1),
  source sponsor_lead_scan_source NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sponsor_lead_scan_events_lead_captured_idx
  ON sponsor_lead_scan_events (lead_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS sponsor_lead_scan_events_device_captured_idx
  ON sponsor_lead_scan_events (scanner_device_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS sponsor_lead_notes (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES sponsor_leads(id) ON DELETE CASCADE,
  scanner_device_id TEXT REFERENCES sponsor_scanner_devices(id) ON DELETE SET NULL,
  operator_name TEXT NOT NULL,
  note TEXT,
  rating INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sponsor_lead_notes_has_change CHECK (note IS NOT NULL OR rating IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS sponsor_lead_notes_lead_created_idx
  ON sponsor_lead_notes (lead_id, created_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('20260904_001_lead_scanner')
ON CONFLICT (version) DO NOTHING;

COMMIT;
