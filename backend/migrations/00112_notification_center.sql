-- +goose Up
-- Rule-based notification center: categories people consent to, central and personal notification rules, per-person
-- preferences, and the delivery log of fired rules. Rules are stored as validated JSON (version 1); the service
-- package enforces the definition's contents, the constraints below only guard the columns around it.

-- Categories group rules by the reason a person may be contacted. A 'required' category is service communication and
-- needs no consent; a 'consent' category reaches only people who said yes to its current text. The three seeded
-- categories carry a fixed key; the key 'service' marks the one category that can neither change nor disappear.
CREATE TABLE notification_categories (
    id uuid PRIMARY KEY,
    key text UNIQUE CHECK (key IN ('service', 'news', 'surveys')),
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 80),
    description text NOT NULL DEFAULT '' CHECK (length(description) <= 600),
    basis text NOT NULL CHECK (basis IN ('required', 'consent')),
    -- Bumped when the wording changes materially ("ask again"): answers given to an older text no longer count.
    text_version integer NOT NULL DEFAULT 1 CHECK (text_version >= 1),
    text_changed_at timestamptz NOT NULL DEFAULT now(),
    position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 1000),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (key IS DISTINCT FROM 'service' OR basis = 'required')
);
CREATE UNIQUE INDEX notification_categories_name_idx ON notification_categories (lower(name));

INSERT INTO notification_categories (id, key, name, description, basis, position) VALUES
    (uuidv7(), 'service', 'Service & safety',
     'Messages you need to use the makerspace: your prints and jobs, orders and payments, open-day duties, trainings, '
     'Lab Rules, machine safety and your account security.', 'required', 0),
    (uuidv7(), 'news', 'News & events',
     'Workshops, events, new machines and other news from the makerspace.', 'consent', 1),
    (uuidv7(), 'surveys', 'Surveys & feedback',
     'Surveys we send you by e-mail or in the app, about your visit or an open day. The tablet may still ask once at '
     'check-out; that has its own switch.', 'consent', 2);

-- A person's answer to one consent category. The row holds the latest answer only; "pending" means a consent
-- category without a row at its current text_version. Withdrawn answers stay as proof of the withdrawal.
CREATE TABLE notification_consents (
    person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    category_id uuid NOT NULL REFERENCES notification_categories(id) ON DELETE CASCADE,
    granted boolean NOT NULL,
    text_version integer NOT NULL CHECK (text_version >= 1),
    answered_at timestamptz NOT NULL,
    place text NOT NULL CHECK (place IN ('app', 'kiosk', 'profile')),
    device_id uuid REFERENCES managed_devices(id) ON DELETE SET NULL,
    PRIMARY KEY (person_id, category_id)
);
CREATE INDEX notification_consents_category_idx ON notification_consents (category_id, granted);

-- Central rules (owner_account_id IS NULL) are managed by staff with notification_rules.manage and always belong to a
-- category. Personal rules are subscriptions owned by one account: no category, never mandatory, and they only ever
-- reach their owner. system_key marks the rules that replace the fixed notifications of earlier versions.
CREATE TABLE notification_rules (
    id uuid PRIMARY KEY,
    owner_account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 120),
    description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
    category_id uuid REFERENCES notification_categories(id) ON DELETE RESTRICT,
    enabled boolean NOT NULL DEFAULT true,
    -- A mandatory rule cannot be muted completely: people keep at least one channel.
    mandatory boolean NOT NULL DEFAULT false,
    trigger_type text NOT NULL CHECK (trigger_type IN ('event', 'schedule', 'manual')),
    trigger_event text CHECK (trigger_event IS NULL OR (trigger_event ~ '^[a-z][a-z0-9_]*$' AND length(trigger_event) <= 60)),
    definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object' AND octet_length(definition::text) <= 262144),
    system_key text UNIQUE CHECK (system_key IS NULL OR (system_key ~ '^[a-z][a-z0-9_]*$' AND length(system_key) <= 60)),
    -- Schedule rules only: when the scheduler looks at the rule next. NULL means "not computed yet".
    next_run_at timestamptz,
    last_fired_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    CHECK ((trigger_type = 'event') = (trigger_event IS NOT NULL)),
    CHECK ((owner_account_id IS NULL) = (category_id IS NOT NULL)),
    CHECK (owner_account_id IS NULL OR (NOT mandatory AND system_key IS NULL)),
    CHECK (next_run_at IS NULL OR trigger_type = 'schedule')
);
CREATE INDEX notification_rules_event_idx ON notification_rules (trigger_event) WHERE enabled AND trigger_type = 'event';
CREATE INDEX notification_rules_due_idx ON notification_rules (next_run_at) WHERE enabled AND trigger_type = 'schedule';
CREATE INDEX notification_rules_owner_idx ON notification_rules (owner_account_id) WHERE owner_account_id IS NOT NULL;
CREATE INDEX notification_rules_category_idx ON notification_rules (category_id);

-- An account's own channel choice for one rule. A missing row means the rule's default channels. Both channels off
-- is a mute and is refused for mandatory rules by the service.
CREATE TABLE notification_rule_preferences (
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    rule_id uuid NOT NULL REFERENCES notification_rules(id) ON DELETE CASCADE,
    in_app boolean NOT NULL,
    email boolean NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, rule_id)
);
CREATE INDEX notification_rule_preferences_rule_idx ON notification_rule_preferences (rule_id);

CREATE TABLE person_notification_settings (
    person_id uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
    -- Whether the tablet may offer the visit survey at check-out.
    ask_feedback_at_checkout boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- The delivery log: one row per firing of a rule. The summary names what happened in words the staff UI shows; it
-- never holds more personal data than that. Rows are removed with their rule and by the retention policy.
CREATE TABLE notification_firings (
    id uuid PRIMARY KEY,
    rule_id uuid NOT NULL REFERENCES notification_rules(id) ON DELETE CASCADE,
    rule_name text NOT NULL CHECK (length(rule_name) <= 120),
    trigger_type text NOT NULL CHECK (trigger_type IN ('event', 'schedule', 'manual')),
    summary text NOT NULL DEFAULT '' CHECK (length(summary) <= 500),
    -- Escalations and fallbacks of the firing stop when something resolves this token (a cleared error, a taken place).
    resolve_token text CHECK (resolve_token IS NULL OR length(resolve_token) <= 200),
    resolved_at timestamptz,
    resolved_reason text CHECK (resolved_reason IS NULL OR length(resolved_reason) <= 60),
    test boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((resolved_at IS NULL) = (resolved_reason IS NULL))
);
CREATE INDEX notification_firings_rule_idx ON notification_firings (rule_id, created_at DESC);
CREATE INDEX notification_firings_created_idx ON notification_firings (created_at);
CREATE INDEX notification_firings_open_token_idx ON notification_firings (resolve_token) WHERE resolved_at IS NULL AND resolve_token IS NOT NULL;

CREATE TABLE notification_firing_recipients (
    id uuid PRIMARY KEY,
    firing_id uuid NOT NULL REFERENCES notification_firings(id) ON DELETE CASCADE,
    -- NULL for channels that do not address a person (signage, tablet).
    person_id uuid REFERENCES people(id) ON DELETE CASCADE,
    channel text NOT NULL CHECK (channel IN ('in_app', 'email', 'signage', 'tablet')),
    -- 0 is the rule's first actions, 1.. are escalation steps.
    step integer NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 5),
    status text NOT NULL CHECK (status IN (
        'sent', 'skipped_consent', 'skipped_muted', 'skipped_condition', 'throttled', 'fallback'
    )),
    notification_id uuid REFERENCES inbox_notifications(id) ON DELETE SET NULL,
    sent_at timestamptz NOT NULL
);
CREATE INDEX notification_firing_recipients_firing_idx ON notification_firing_recipients (firing_id, step);
CREATE INDEX notification_firing_recipients_person_idx ON notification_firing_recipients (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX notification_firing_recipients_notification_idx ON notification_firing_recipients (notification_id) WHERE notification_id IS NOT NULL;

-- Actions that wait: delayed actions, e-mail fallbacks and escalation steps. The scheduler delivers them once due and
-- skips them when their firing was resolved in the meantime.
CREATE TABLE notification_pending_actions (
    id uuid PRIMARY KEY,
    firing_id uuid NOT NULL REFERENCES notification_firings(id) ON DELETE CASCADE,
    due_at timestamptz NOT NULL,
    step integer NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 5),
    action jsonb NOT NULL CHECK (jsonb_typeof(action) = 'object'),
    -- The loop item the action is about (identifiers only).
    item jsonb CHECK (item IS NULL OR jsonb_typeof(item) = 'object'),
    recipients jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(recipients) = 'array'),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_pending_actions_due_idx ON notification_pending_actions (due_at);
CREATE INDEX notification_pending_actions_firing_idx ON notification_pending_actions (firing_id);

-- Throttle memory: when a rule last fired for a subject (a machine, an error code, a person, a loop item).
CREATE TABLE notification_throttle (
    rule_id uuid NOT NULL REFERENCES notification_rules(id) ON DELETE CASCADE,
    subject_key text NOT NULL CHECK (subject_key <> '' AND length(subject_key) <= 200),
    last_at timestamptz NOT NULL,
    PRIMARY KEY (rule_id, subject_key)
);
CREATE INDEX notification_throttle_last_idx ON notification_throttle (last_at);

-- +goose Down
DROP TABLE notification_throttle;
DROP TABLE notification_pending_actions;
DROP TABLE notification_firing_recipients;
DROP TABLE notification_firings;
DROP TABLE person_notification_settings;
DROP TABLE notification_rule_preferences;
DROP TABLE notification_rules;
DROP TABLE notification_consents;
DROP TABLE notification_categories;
