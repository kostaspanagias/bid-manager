-- Bid Manager MVP — complete initial schema.
-- Conventions (ARCHITECTURE.md): uuid ids, org_id NOT NULL on every table, created_at/updated_at/created_by,
-- enum-like text columns with CHECK constraints (English snake_case), unique keys include org_id,
-- ON DELETE CASCADE from tender to its children, indexes on (org_id, tender_id).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------------------------------------------
-- Organization and people
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE organization (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  timezone        text NOT NULL DEFAULT 'Europe/Athens',
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
  retention_days  integer CHECK (retention_days IS NULL OR retention_days >= 0),  -- closed-tender file retention (GDPR)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid
);

CREATE TABLE "user" (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organization(id),
  email               text NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
  name                text NOT NULL,
  org_role            text NOT NULL DEFAULT 'member'
                        CHECK (org_role IN ('admin', 'bid_manager', 'member', 'approver', 'viewer')),
  password_hash       text,                       -- Argon2id; NULL = cannot log in
  totp_secret         text,                       -- encrypted at rest (core/crypto.ts)
  totp_enabled_at     timestamptz,                -- NULL = must enrol before a full session
  totp_last_step      bigint,                     -- last accepted TOTP time step (replay protection)
  active              boolean NOT NULL DEFAULT true,
  failed_login_count  integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  last_login_at       timestamptz,
  settings            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- per-user preferences (e.g. digest opt-out)
  anonymized_at       timestamptz,                -- GDPR erasure marker
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES "user"(id) ON DELETE SET NULL,
  UNIQUE (org_id, email)
);
CREATE INDEX user_email_idx ON "user" (email);

ALTER TABLE organization
  ADD CONSTRAINT organization_created_by_fkey FOREIGN KEY (created_by) REFERENCES "user"(id) ON DELETE SET NULL;

-- id = sha256 hex of the opaque cookie token (the token itself is never stored).
CREATE TABLE session (
  id             text PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES organization(id),
  user_id        uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  totp_verified  boolean NOT NULL DEFAULT false,
  csrf_token     text NOT NULL,
  totp_attempts  integer NOT NULL DEFAULT 0,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,            -- idle expiry, pushed forward on activity
  ip             text,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES "user"(id) ON DELETE SET NULL
);
CREATE INDEX session_user_idx ON session (org_id, user_id);
CREATE INDEX session_expires_idx ON session (expires_at);

CREATE TABLE invitation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organization(id),
  email             text NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
  org_role          text NOT NULL DEFAULT 'member'
                      CHECK (org_role IN ('admin', 'bid_manager', 'member', 'approver', 'viewer')),
  token_hash        text NOT NULL,
  expires_at        timestamptz NOT NULL,
  accepted_at       timestamptz,
  accepted_user_id  uuid REFERENCES "user"(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES "user"(id) ON DELETE SET NULL,
  UNIQUE (org_id, token_hash)
);
CREATE INDEX invitation_token_idx ON invitation (token_hash);
CREATE INDEX invitation_email_idx ON invitation (org_id, email);

CREATE TABLE holiday (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id),
  date        date NOT NULL,
  name        text NOT NULL,
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('national', 'movable', 'manual')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES "user"(id) ON DELETE SET NULL,
  UNIQUE (org_id, date)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Templates (F2, F10)
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE template (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organization(id),
  name                text NOT NULL,
  version             text NOT NULL,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  parent_template_id  uuid REFERENCES template(id) ON DELETE SET NULL,
  description         text,
  published_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES "user"(id) ON DELETE SET NULL,
  UNIQUE (org_id, name, version)
);

-- Offsets are signed: anchor='T', offset_value=-8 => T-8; anchor='T0', offset_value=3 => T0+3; anchor='G0', 2 => G0+2.
CREATE TABLE template_item (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(id),
  template_id     uuid NOT NULL REFERENCES template(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('role', 'gate', 'milestone', 'task', 'handoff', 'checklist_item',
                                                'watch_item', 'gate_criterion')),
  key             text,
  name            text NOT NULL,
  owner_role_key  text,
  offset_value    integer,
  offset_unit     text CHECK (offset_unit IN ('working', 'calendar')),
  anchor          text,                            -- 'T' | 'T0' | key of another item
  condition       text NOT NULL DEFAULT 'always' CHECK (condition IN ('always', 'demo', 'partners')),
  sort            integer NOT NULL DEFAULT 0,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES "user"(id) ON DELETE SET NULL
);
CREATE INDEX template_item_template_idx ON template_item (org_id, template_id, kind, sort);

-- ---------------------------------------------------------------------------------------------------------------
-- Tenders (F1) and their team
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE tender (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL REFERENCES organization(id),
  title                   text NOT NULL,
  authority               text,
  adam                    text,
  esidis_no               text,
  cpv                     text[] NOT NULL DEFAULT '{}',
  budget_net              numeric(14,2),
  budget_gross            numeric(14,2),
  lots                    jsonb NOT NULL DEFAULT '[]'::jsonb,
  t0_published_at         timestamptz,
  questions_deadline_at   timestamptz,
  submission_deadline_at  timestamptz NOT NULL,    -- T = its Athens-local date
  guarantee_amount        numeric(14,2),
  guarantee_valid_until   date,
  guarantee_margin_days   integer NOT NULL DEFAULT 30 CHECK (guarantee_margin_days >= 0),
  offer_validity_days     integer CHECK (offer_validity_days IS NULL OR offer_validity_days >= 0),
  has_demo                boolean NOT NULL DEFAULT false,
  has_partners            boolean NOT NULL DEFAULT false,
  status                  text NOT NULL DEFAULT 'evaluation'
                            CHECK (status IN ('evaluation', 'in_progress', 'submitted', 'no_go', 'cancelled')),
  compressed_mode         boolean NOT NULL DEFAULT false,
  template_id             uuid REFERENCES template(id) ON DELETE SET NULL,
  template_version        text,
  template_snapshot       jsonb,
  notes                   text,
  closed_at               timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid REFERENCES "user"(id) ON DELETE SET NULL
);
CREATE INDEX tender_org_status_idx ON tender (org_id, status);
CREATE INDEX tender_org_deadline_idx ON tender (org_id, submission_deadline_at);

-- Per-tender snapshot of the template roles. payload.folder in participation/technical/financial;
-- payload.financial = true marks the financial-offer role (R18).
CREATE TABLE tender_role (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id),
  tender_id   uuid NOT NULL REFERENCES tender(id) ON DELETE CASCADE,
  key         text NOT NULL,
  name        text NOT NULL,
  sort        integer NOT NULL DEFAULT 0,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES "user"(id) ON DELETE SET NULL,
  UNIQUE (org_id, tender_id, key)
);

-- A user may hold several roles in a tender (one row per role); tender_role_key NULL = plain member.
CREATE TABLE tender_member (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organization(id),
  tender_id        uuid NOT NULL REFERENCES tender(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  tender_role_key  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES "user"(id) ON DELETE SET NULL,
  UNIQUE NULLS NOT DISTINCT (org_id, tender_id, user_id, tender_role_key)
);
CREATE INDEX tender_member_user_idx ON tender_member (org_id, user_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Schedule and gates (F3, F4)
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE milestone (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organization(id),
  tender_id      uuid NOT NULL REFERENCES tender(id) ON DELETE CASCADE,
  key            text NOT NULL,
  name           text NOT NULL,
  kind           text NOT NULL DEFAULT 'milestone' CHECK (kind IN ('gate', 'milestone', 'handoff')),
  due_date       date,
  computed_from  jsonb,                             -- {anchor, offset_value, offset_unit, ...}
  is_manual      boolean NOT NULL DEFAULT false,    -- manual date: not recomputed (F3)
  needs_review   boolean NOT NULL DEFAULT false,    -- manual milestone flagged after an extension (R9)
  done_at        timestamptz,                       -- completed: never moved (R10)
  sort           integer NOT NULL DEFAULT 0,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES "user"(id) ON DELETE SET NULL,
  UNIQUE (org_id, tender_id, key)
);
CREATE INDEX milestone_due_idx ON milestone (org_id, due_date);

CREATE TABLE gate (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organization(id),
  tender_id          uuid NOT NULL REFERENCES tender(id) ON DELETE CASCADE,
  milestone_id       uuid NOT NULL REFERENCES milestone(id) ON DELETE CASCADE,
  key                text,                          -- convenience copy of the milestone key (G0..G4)
  decision_mode      text NOT NULL DEFAULT 'approval' CHECK (decision_mode IN ('approval', 'go_no_go')),
  approver_user_id   uuid REFERENCES "user"(id) ON DELETE SET NULL,
  approver_role_key  text,
  decision           text NOT NULL DEFAULT 'pending'
                       CHECK (decision IN ('pending', 'approved', 'approved_with_exception', 'rejected', 'go', 'no_go')),
  justification      text,
  decided_by         uuid REFERENCES "user"(id) ON DELETE SET NULL,
  decided_at         timestamptz,
  requested_at       timestamptz,                   -- approval requested
  requested_by       uuid REFERENCES "user"(id) ON DELETE SET NULL,
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES "user"(id) ON DELETE SET NULL,
  UNIQUE (org_id, milestone_id)
);
CREATE INDEX gate_tender_idx ON gate (org_id, tender_id);
CREATE INDEX gate_approver_idx ON gate (org_id, approver_user_id);

CREATE TABLE gate_criterion (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id),
  tender_id   uuid NOT NULL REFERENCES tender(id) ON DELETE CASCADE,
  gate_id     uuid NOT NULL REFERENCES gate(id) ON DELETE CASCADE,
  key         text,
  text        text NOT NULL,
  type        text NOT NULL DEFAULT 'manual' CHECK (type IN ('manual', 'auto')),
  auto_rule   text CHECK (auto_rule IN ('exclusion_evidence_100', 'register_no_open', 'handoffs_received',
                                        'guarantee_arrived', 'docs_valid_on_T')),
  checked_by  uuid REFERENCES "user"(id) ON DELETE SET NULL,
  checked_at  timestamptz,
  note        text,
  sort        integer NOT NULL DEFAULT 0,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES "user"(id) ON DELETE SET NULL,
  CHECK ((type = 'auto') = (auto_rule IS NOT NULL))
);
CREATE INDEX gate_criterion_gate_idx ON gate_criterion (org_id, gate_id, sort);
CREATE INDEX gate_criterion_tender_idx ON gate_criterion (org_id, tender_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Requirements register (F5)
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE requirement (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(id),
  tender_id       uuid NOT NULL REFERENCES tender(id) ON DELETE CASCADE,
  code            text NOT NULL,                    -- ΥΠ-nnn, unique per tender (R17)
  source_ref      text,
  text            text NOT NULL DEFAULT '',
  type            text NOT NULL DEFAULT 'formal' CHECK (type IN ('exclusion', 'scored', 'formal')),
  folder          text CHECK (folder IN ('participation', 'technical', 'financial')),
  owner_user_id   uuid REFERENCES "user"(id) ON DELETE SET NULL,
  owner_role_key  text,
  response_ref    text,
  evidence_ref    text,
  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'in_progress', 'covered', 'verified', 'deviation')),
  deviation_note  text,
  weight          text,                             -- scored: criterion + coefficient, free text
  sort            integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES "user"(id) ON DELETE SET NULL,
  UNIQUE (org_id, tender_id, code),
  CONSTRAINT requirement_deviation_needs_note
    CHECK (status <> 'deviation' OR length(btrim(coalesce(deviation_note, ''))) > 0)
);
CREATE INDEX requirement_filter_idx ON requirement (org_id, tender_id, type, status);
CREATE INDEX requirement_owner_idx ON requirement (org_id, owner_user_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Tasks, checklists, handoffs (F6)
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE task (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organization(id),
  tender_id          uuid NOT NULL REFERENCES tender(id) ON DELETE CASCADE,
  milestone_id       uuid REFERENCES milestone(id) ON DELETE SET NULL,
  key                text,                          -- template item key, when created from a template
  title              text NOT NULL,
  description        text,
  owner_user_id      uuid REFERENCES "user"(id) ON DELETE SET NULL,
  owner_role_key     text,
  due_date           date,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'na', 'cancelled')),
  section            text NOT NULL DEFAULT 'task' CHECK (section IN ('task', 'checklist', 'handoff')),
  handoff_from_role  text,
  handoff_to_role    text,
  received_by        uuid REFERENCES "user"(id) ON DELETE SET NULL,
  received_at        timestamptz,
  done_at            timestamptz,
  sort               integer NOT NULL DEFAULT 0,
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES "user"(id) ON DELETE SET NULL
);
CREATE INDEX task_tender_idx ON task (org_id, tender_id, section, sort);
CREATE INDEX task_owner_idx ON task (org_id, owner_user_id, status);
CREATE INDEX task_due_idx ON task (org_id, due_date);
CREATE INDEX task_milestone_idx ON task (milestone_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Watchlist, risks, change log (F7)
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE watch_item (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organization(id),
  tender_id             uuid NOT NULL REFERENCES tender(id) ON DELETE CASCADE,
  key                   text,                       -- template item key (e.g. 'guarantee')
  name                  text NOT NULL,
  owner_user_id         uuid REFERENCES "user"(id) ON DELETE SET NULL,
  owner_role_key        text,
  lead_value            integer CHECK (lead_value IS NULL OR lead_value >= 0),
  lead_unit             text CHECK (lead_unit IN ('working', 'calendar')),
  needed_at             date,                       -- date the item is needed (R6)
  needed_milestone_key  text,                       -- ...or the milestone it is needed at (e.g. 'G4')
  requested_at          date,
  expected_at           date,
  arrived_at            date,
  checks                text,                       -- "what we check" from the blueprint
  notes                 text,
  sort                  integer NOT NULL DEFAULT 0,
  payload               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES "user"(id) ON DELETE SET NULL
);
CREATE INDEX watch_item_tender_idx ON watch_item (org_id, tender_id, sort);
CREATE INDEX watch_item_owner_idx ON watch_item (org_id, owner_user_id);

CREATE TABLE risk (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organization(id),
  tender_id      uuid NOT NULL REFERENCES tender(id) ON DELETE CASCADE,
  title          text NOT NULL,
  "trigger"      text,
  mitigation     text,
  owner_user_id  uuid REFERENCES "user"(id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'mitigating', 'occurred', 'closed')),
  sort           integer NOT NULL DEFAULT 0,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES "user"(id) ON DELETE SET NULL
);
CREATE INDEX risk_tender_idx ON risk (org_id, tender_id);

CREATE TABLE change_entry (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organization(id),
  tender_id      uuid NOT NULL REFERENCES tender(id) ON DELETE CASCADE,
  date           date NOT NULL DEFAULT CURRENT_DATE,
  source         text NOT NULL DEFAULT 'other' CHECK (source IN ('adam', 'esidis', 'email', 'other')),
  kind           text NOT NULL DEFAULT 'clarification' CHECK (kind IN ('clarification', 'amendment', 'extension')),
  description    text NOT NULL DEFAULT '',
  reference      text,                              -- ADAM number, URL, e-mail subject...
  owner_user_id  uuid REFERENCES "user"(id) ON DELETE SET NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb, -- e.g. {oldT, newT} for extensions
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES "user"(id) ON DELETE SET NULL
);
CREATE INDEX change_entry_tender_idx ON change_entry (org_id, tender_id, date);

CREATE TABLE change_entry_requirement (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organization(id),
  tender_id        uuid NOT NULL REFERENCES tender(id) ON DELETE CASCADE,
  change_entry_id  uuid NOT NULL REFERENCES change_entry(id) ON DELETE CASCADE,
  requirement_id   uuid NOT NULL REFERENCES requirement(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES "user"(id) ON DELETE SET NULL,
  UNIQUE (org_id, change_entry_id, requirement_id)
);
CREATE INDEX change_entry_requirement_req_idx ON change_entry_requirement (org_id, requirement_id);
CREATE INDEX change_entry_requirement_tender_idx ON change_entry_requirement (org_id, tender_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Files and company documents (F1, F8)
-- ---------------------------------------------------------------------------------------------------------------

-- Stored at {FILE_STORAGE_DIR}/{org_id}/{tender_id|org}/{file_id}; the original filename lives only here.
CREATE TABLE file (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organization(id),
  tender_id        uuid REFERENCES tender(id) ON DELETE CASCADE,   -- NULL = org-level (company documents)
  storage_key      text NOT NULL,
  filename         text NOT NULL,
  mime             text,
  size             bigint NOT NULL DEFAULT 0 CHECK (size >= 0),
  sha256           text,
  folder           text NOT NULL DEFAULT 'other'
                     CHECK (folder IN ('participation', 'technical', 'financial', 'tender_docs', 'clarifications', 'other')),
  confidentiality  text NOT NULL DEFAULT 'normal' CHECK (confidentiality IN ('normal', 'financial')),
  label            text,
  uploaded_by      uuid REFERENCES "user"(id) ON DELETE SET NULL,
  enc              jsonb,                           -- encryption metadata {alg, iv, tag, ...}
  deleted_at       timestamptz,                     -- soft delete; blob removed by retention/GDPR
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES "user"(id) ON DELETE SET NULL,
  UNIQUE (org_id, storage_key)
);
CREATE INDEX file_tender_idx ON file (org_id, tender_id, folder);

CREATE TABLE company_document (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id),
  type         text NOT NULL DEFAULT 'other'
                 CHECK (type IN ('iso', 'gemi', 'tax', 'insurance', 'cv', 'reference_project', 'other')),
  title        text NOT NULL,
  file_id      uuid REFERENCES file(id) ON DELETE SET NULL,
  issued_at    date,
  expires_at   date,
  person_name  text,                                -- CVs (personal data, GDPR)
  notes        text,
  archived_at  timestamptz,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES "user"(id) ON DELETE SET NULL
);
CREATE INDEX company_document_expiry_idx ON company_document (org_id, expires_at);
CREATE INDEX company_document_type_idx ON company_document (org_id, type);

CREATE TABLE tender_document (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organization(id),
  tender_id            uuid NOT NULL REFERENCES tender(id) ON DELETE CASCADE,
  company_document_id  uuid NOT NULL REFERENCES company_document(id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES "user"(id) ON DELETE SET NULL,
  UNIQUE (org_id, tender_id, company_document_id)
);
CREATE INDEX tender_document_doc_idx ON tender_document (org_id, company_document_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Lessons learned (F10)
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE lesson (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organization(id),
  tender_id            uuid NOT NULL REFERENCES tender(id) ON DELETE CASCADE,
  text                 text NOT NULL,
  category             text,
  changes_template     boolean NOT NULL DEFAULT false,
  applied_in_version   text,
  applied_template_id  uuid REFERENCES template(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES "user"(id) ON DELETE SET NULL
);
CREATE INDEX lesson_tender_idx ON lesson (org_id, tender_id);
CREATE INDEX lesson_pending_idx ON lesson (org_id, changes_template) WHERE applied_in_version IS NULL;

-- ---------------------------------------------------------------------------------------------------------------
-- Operational tables
-- ---------------------------------------------------------------------------------------------------------------

-- Append-only (trigger below). before/after: full row for create/delete, changed columns only for update.
CREATE TABLE audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organization(id),
  user_id    uuid,                                  -- no FK: the log must survive anything
  entity     text NOT NULL,
  entity_id  text,
  tender_id  uuid,                                  -- filled when the row belongs to a tender
  action     text NOT NULL,                         -- create | update | delete | custom verbs
  before     jsonb,
  after      jsonb,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_at_idx ON audit_log (org_id, at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (org_id, entity, entity_id);
CREATE INDEX audit_log_user_idx ON audit_log (org_id, user_id);
CREATE INDEX audit_log_tender_idx ON audit_log (org_id, tender_id);

CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

-- Idempotency + execution log for scheduled jobs: at most one run per org, job and date.
CREATE TABLE job_run (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id),
  job          text NOT NULL,
  run_date     date NOT NULL,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed')),
  attempts     integer NOT NULL DEFAULT 1,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  detail       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  UNIQUE (org_id, job, run_date)
);

CREATE TABLE email_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id),
  user_id     uuid REFERENCES "user"(id) ON DELETE SET NULL,
  to_email    text,
  kind        text NOT NULL,
  dedupe_key  text NOT NULL,
  subject     text NOT NULL DEFAULT '',
  body        text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'sent' CHECK (status IN ('pending', 'sent', 'failed')),
  error       text,
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  UNIQUE (org_id, dedupe_key)
);
CREATE INDEX email_log_user_idx ON email_log (org_id, user_id, created_at DESC);

-- ---------------------------------------------------------------------------------------------------------------
-- updated_at is maintained by trigger on every table that has it (also covers raw SQL updates).
-- ---------------------------------------------------------------------------------------------------------------

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND column_name = 'updated_at'
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
                   t || '_set_updated_at', t);
  END LOOP;
END;
$$;
