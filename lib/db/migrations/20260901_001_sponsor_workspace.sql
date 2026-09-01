BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN CREATE TYPE sponsor_status AS ENUM ('draft', 'confirmed', 'paused', 'completed', 'cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE sponsor_contact_role AS ENUM ('primary', 'onsite', 'marketing', 'other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE sponsor_promo_kind AS ENUM ('vip', 'public'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE sponsor_task_status AS ENUM ('todo', 'submitted', 'completed', 'overdue', 'not_required'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE sponsor_session_type AS ENUM ('quickfire', 'keynote', 'other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE sponsor_session_status AS ENUM ('draft', 'submitted', 'changes_requested', 'approved', 'exported'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE sponsor_asset_category AS ENUM ('logo', 'headshot', 'slides', 'session_material', 'logistics', 'other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE sponsor_asset_status AS ENUM ('active', 'archived', 'missing'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE sponsor_redemption_status AS ENUM ('reserved', 'released'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE registration_source AS ENUM ('checkout', 'manual', 'sponsor_staff'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE email_template_type ADD VALUE IF NOT EXISTS 'sponsor_welcome';
ALTER TYPE email_template_type ADD VALUE IF NOT EXISTS 'sponsor_staff';
ALTER TYPE email_log_type ADD VALUE IF NOT EXISTS 'sponsor_welcome';
ALTER TYPE email_log_type ADD VALUE IF NOT EXISTS 'sponsor_staff';
ALTER TYPE email_log_type ADD VALUE IF NOT EXISTS 'sponsor_internal';

CREATE TABLE IF NOT EXISTS sponsors (
  id SERIAL PRIMARY KEY,
  company TEXT NOT NULL,
  package_label TEXT NOT NULL,
  status sponsor_status NOT NULL DEFAULT 'draft',
  confirmation_date DATE,
  notes TEXT,
  vip_allocation INTEGER NOT NULL DEFAULT 0 CHECK (vip_allocation >= 0),
  vip_max_per_booking INTEGER NOT NULL DEFAULT 1 CHECK (vip_max_per_booking >= 1),
  staff_allocation INTEGER NOT NULL DEFAULT 0 CHECK (staff_allocation >= 0),
  vip_code_draft TEXT NOT NULL,
  public_code_draft TEXT NOT NULL,
  portal_access_version INTEGER NOT NULL DEFAULT 1 CHECK (portal_access_version >= 1),
  required_deliverables JSONB NOT NULL DEFAULT '{}'::jsonb,
  confirmed_at TIMESTAMPTZ,
  welcome_email_sent_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sponsors_company_lower_idx ON sponsors (lower(company));
CREATE INDEX IF NOT EXISTS sponsors_status_idx ON sponsors (status);

CREATE TABLE IF NOT EXISTS sponsor_contacts (
  id SERIAL PRIMARY KEY,
  sponsor_id INTEGER NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  role sponsor_contact_role NOT NULL DEFAULT 'other',
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  job_title TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sponsor_contacts_sponsor_idx ON sponsor_contacts (sponsor_id);
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_contacts_sponsor_email_uniq ON sponsor_contacts (sponsor_id, lower(email));

ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS max_quantity_per_booking INTEGER;
ALTER TABLE promo_codes DROP CONSTRAINT IF EXISTS promo_codes_max_quantity_per_booking_check;
ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_max_quantity_per_booking_check CHECK (max_quantity_per_booking IS NULL OR max_quantity_per_booking > 0);

CREATE TABLE IF NOT EXISTS sponsor_promo_codes (
  id SERIAL PRIMARY KEY,
  sponsor_id INTEGER NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  promo_code_id INTEGER NOT NULL REFERENCES promo_codes(id) ON DELETE RESTRICT,
  kind sponsor_promo_kind NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_promo_codes_sponsor_kind_uniq ON sponsor_promo_codes (sponsor_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_promo_codes_promo_uniq ON sponsor_promo_codes (promo_code_id);

CREATE TABLE IF NOT EXISTS sponsor_tasks (
  id SERIAL PRIMARY KEY,
  sponsor_id INTEGER NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  label TEXT NOT NULL,
  required BOOLEAN NOT NULL DEFAULT TRUE,
  due_at TIMESTAMPTZ,
  status sponsor_task_status NOT NULL DEFAULT 'todo',
  completed_at TIMESTAMPTZ,
  last_deadline_check_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_tasks_sponsor_key_uniq ON sponsor_tasks (sponsor_id, task_key);
CREATE INDEX IF NOT EXISTS sponsor_tasks_due_idx ON sponsor_tasks (due_at, status);

CREATE TABLE IF NOT EXISTS sponsor_sessions (
  id SERIAL PRIMARY KEY,
  sponsor_id INTEGER NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  type sponsor_session_type NOT NULL,
  entitlement_label TEXT NOT NULL,
  title TEXT,
  description TEXT,
  takeaways TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status sponsor_session_status NOT NULL DEFAULT 'draft',
  headshot_required BOOLEAN NOT NULL DEFAULT TRUE,
  takeaways_required BOOLEAN NOT NULL DEFAULT TRUE,
  slides_required BOOLEAN NOT NULL DEFAULT FALSE,
  feedback TEXT,
  current_revision INTEGER NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  exported_at TIMESTAMPTZ,
  exported_revision INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sponsor_sessions_takeaways_max_three CHECK (cardinality(takeaways) <= 3)
);
CREATE INDEX IF NOT EXISTS sponsor_sessions_sponsor_idx ON sponsor_sessions (sponsor_id);
CREATE INDEX IF NOT EXISTS sponsor_sessions_status_idx ON sponsor_sessions (status);

CREATE TABLE IF NOT EXISTS sponsor_session_revisions (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sponsor_sessions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_session_revisions_session_revision_uniq ON sponsor_session_revisions (session_id, revision);

CREATE TABLE IF NOT EXISTS sponsor_presenters (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sponsor_sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  job_title TEXT NOT NULL,
  company TEXT NOT NULL,
  biography TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sponsor_presenters_session_idx ON sponsor_presenters (session_id);

CREATE TABLE IF NOT EXISTS sponsor_assets (
  id TEXT PRIMARY KEY,
  sponsor_id INTEGER NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES sponsor_sessions(id) ON DELETE SET NULL,
  presenter_id INTEGER REFERENCES sponsor_presenters(id) ON DELETE SET NULL,
  category sponsor_asset_category NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  checksum_sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  status sponsor_asset_status NOT NULL DEFAULT 'active',
  replaces_asset_id TEXT REFERENCES sponsor_assets(id) ON DELETE SET NULL,
  uploader_type TEXT NOT NULL,
  uploader_label TEXT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sponsor_assets_sponsor_idx ON sponsor_assets (sponsor_id);
CREATE INDEX IF NOT EXISTS sponsor_assets_library_idx ON sponsor_assets (status, category, created_at);

CREATE TABLE IF NOT EXISTS sponsor_documents (
  id SERIAL PRIMARY KEY,
  sponsor_id INTEGER NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES sponsor_assets(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  required BOOLEAN NOT NULL DEFAULT TRUE,
  acknowledgement_version INTEGER NOT NULL DEFAULT 1 CHECK (acknowledgement_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sponsor_documents_sponsor_idx ON sponsor_documents (sponsor_id);

CREATE TABLE IF NOT EXISTS sponsor_document_acknowledgements (
  id SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES sponsor_documents(id) ON DELETE CASCADE,
  sponsor_contact_id INTEGER REFERENCES sponsor_contacts(id) ON DELETE SET NULL,
  version INTEGER NOT NULL,
  acknowledged_by TEXT NOT NULL,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_document_ack_version_uniq ON sponsor_document_acknowledgements (document_id, version);

CREATE TABLE IF NOT EXISTS sponsor_pass_requests (
  id SERIAL PRIMARY KEY,
  sponsor_id INTEGER NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  requested_vip INTEGER NOT NULL DEFAULT 0 CHECK (requested_vip >= 0),
  requested_staff INTEGER NOT NULL DEFAULT 0 CHECK (requested_staff >= 0),
  message TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sponsor_pass_requests_sponsor_idx ON sponsor_pass_requests (sponsor_id, status);

CREATE TABLE IF NOT EXISTS sponsor_activity (
  id SERIAL PRIMARY KEY,
  sponsor_id INTEGER NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_label TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sponsor_activity_sponsor_created_idx ON sponsor_activity (sponsor_id, created_at DESC);

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS registration_source registration_source NOT NULL DEFAULT 'checkout';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS sponsor_id INTEGER REFERENCES sponsors(id) ON DELETE SET NULL;
UPDATE bookings SET registration_source = 'manual' WHERE manual_entry = TRUE AND registration_source = 'checkout';
CREATE INDEX IF NOT EXISTS bookings_sponsor_source_idx ON bookings (sponsor_id, registration_source, status);

ALTER TABLE attendees ADD COLUMN IF NOT EXISTS community_social_attending BOOLEAN;
ALTER TABLE attendees ADD COLUMN IF NOT EXISTS community_social_dietary TEXT;

ALTER TABLE notification_emails ADD COLUMN IF NOT EXISTS notify_sponsor_admin BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE notification_emails ADD COLUMN IF NOT EXISTS notify_sponsor_passes BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE notification_emails ADD COLUMN IF NOT EXISTS notify_sponsor_content BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE notification_emails ADD COLUMN IF NOT EXISTS notify_sponsor_deadlines BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS sponsor_id INTEGER REFERENCES sponsors(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS email_logs_sponsor_id_idx ON email_logs (sponsor_id);

CREATE TABLE IF NOT EXISTS sponsor_redemptions (
  id SERIAL PRIMARY KEY,
  sponsor_id INTEGER NOT NULL REFERENCES sponsors(id) ON DELETE RESTRICT,
  promo_code_id INTEGER NOT NULL REFERENCES promo_codes(id) ON DELETE RESTRICT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  units INTEGER NOT NULL CHECK (units > 0),
  status sponsor_redemption_status NOT NULL DEFAULT 'reserved',
  reservation_key TEXT NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at TIMESTAMPTZ,
  release_reason TEXT,
  notification_sent_at TIMESTAMPTZ,
  notification_failed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_redemptions_reservation_key_uniq ON sponsor_redemptions (reservation_key);
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_redemptions_booking_promo_uniq ON sponsor_redemptions (booking_id, promo_code_id);
CREATE INDEX IF NOT EXISTS sponsor_redemptions_sponsor_status_idx ON sponsor_redemptions (sponsor_id, status);

INSERT INTO schema_migrations (version)
VALUES ('20260901_001_sponsor_workspace')
ON CONFLICT (version) DO NOTHING;

COMMIT;
