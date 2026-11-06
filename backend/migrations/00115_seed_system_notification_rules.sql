-- +goose Up
-- The notifications the application used to write itself become central rules of the service category, one per old
-- behaviour, and the printer rules of migration 00098 are translated into them: the operator, the job's recipient, a
-- role, the extra e-mail and the minimum level of printer errors keep reaching exactly the people they reached.

-- +goose StatementBegin
CREATE FUNCTION pg_temp.seed_system_rule(
    p_key text, p_name text, p_description text, p_event text, p_mandatory boolean, p_enabled boolean,
    p_conditions jsonb, p_recipients jsonb, p_email boolean, p_title text, p_body text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    in_app jsonb := jsonb_build_object(
        'channel', 'in_app', 'delayMinutes', 0, 'recipients', p_recipients, 'title', p_title, 'body', p_body,
        'inApp', jsonb_build_object(
            'appearance', 'bell', 'level', 'info', 'toastSeconds', 0, 'button', jsonb_build_object('kind', 'none'),
            'onlyButtonCloses', false, 'allowLater', false, 'onlineOnly', false));
    mail jsonb := jsonb_build_object(
        'channel', 'email', 'delayMinutes', 0, 'recipients', p_recipients, 'title', p_title, 'body', p_body);
BEGIN
    INSERT INTO notification_rules (
        id, name, description, category_id, enabled, mandatory, trigger_type, trigger_event, definition, system_key
    ) VALUES (
        uuidv7(), p_name, p_description, (SELECT id FROM notification_categories WHERE key = 'service'), p_enabled,
        p_mandatory, 'event', p_event,
        jsonb_build_object(
            'trigger', jsonb_build_object('type', 'event', 'event', p_event),
            'loop', NULL,
            'conditions', jsonb_build_object('mode', 'all', 'items', p_conditions),
            'actions', CASE WHEN p_email THEN jsonb_build_array(in_app, mail) ELSE jsonb_build_array(in_app) END,
            'escalation', NULL,
            'throttle', NULL),
        p_key);
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
DECLARE
    r record;
    recipients jsonb;
    conditions jsonb;
    change record;
BEGIN
    FOR r IN
        SELECT e.event,
               COALESCE(p.notify_operator, true) AS notify_operator,
               COALESCE(p.notify_recipient, false) AS notify_recipient,
               p.role_id,
               COALESCE(p.email, false) AS email,
               p.min_severity
        FROM (VALUES ('printer_error'), ('run_finished'), ('filament_change')) e(event)
        LEFT JOIN printer_notification_rules p ON p.event = e.event
    LOOP
        recipients := '[]'::jsonb;
        IF r.notify_operator THEN recipients := recipients || '["operator"]'::jsonb; END IF;
        IF r.notify_recipient THEN recipients := recipients || '["recipient"]'::jsonb; END IF;
        IF r.role_id IS NOT NULL THEN recipients := recipients || to_jsonb('role:' || r.role_id::text); END IF;
        conditions := '[]'::jsonb;
        IF r.event = 'printer_error' AND r.min_severity IS NOT NULL THEN
            conditions := jsonb_build_array(jsonb_build_object('field', 'e.level', 'op', 'gte', 'value', r.min_severity));
        END IF;
        -- A rule nobody was told by stays in place, switched off.
        IF jsonb_array_length(recipients) = 0 THEN
            recipients := '["operator"]'::jsonb;
        END IF;

        IF r.event = 'printer_error' THEN
            PERFORM pg_temp.seed_system_rule(
                'printer_error', 'Printer error', 'Tells the people it names when a printer reports a new error.',
                'printer_error', false, r.notify_operator OR r.notify_recipient OR r.role_id IS NOT NULL, conditions,
                recipients, r.email, 'Printer error on {machine}',
                '{machine} reports the error {code}{levelNote}{meaningNote}{runNote}.');
        ELSIF r.event = 'run_finished' THEN
            PERFORM pg_temp.seed_system_rule(
                'run_finished', 'Run finished', 'Tells the people it names when a run of a job has ended.',
                'run_finished', false, r.notify_operator OR r.notify_recipient OR r.role_id IS NOT NULL, conditions,
                recipients, r.email, 'Run {run} {ending}', 'Run {run}{jobNote} on {machine} {ending}.');
        ELSE
            FOR change IN SELECT * FROM (VALUES
                ('filament_loaded', 'Spool loaded', 'loaded', 'Spool loaded on {machine}',
                 'Spool {spool} was loaded into slot {slot} of {machine}. Run {run} is printing.'),
                ('filament_unloaded', 'Spool removed', 'unloaded', 'Spool removed from {machine}',
                 'Spool {spool} was removed from slot {slot} of {machine}. Run {run} is printing.'),
                ('filament_unknown_tag', 'New material in a printer', 'unknown_tag', 'New material on {machine}',
                 'Slot {slot} of {machine} holds new material{materialNote} whose RFID tag belongs to no spool here. '
                 'Assign a spool on the printer page. Run {run} is printing.'),
                ('filament_no_tag', 'Material without a tag in a printer', 'no_tag', 'Material without tag on {machine}',
                 'Slot {slot} of {machine} holds material{materialNote} without a readable RFID tag. '
                 'Load the spool by hand on the printer page. Run {run} is printing.')
            ) c(key, name, change, title, body)
            LOOP
                PERFORM pg_temp.seed_system_rule(
                    change.key, change.name, 'Tells the people it names about a filament change in a printer while a run is printing.',
                    'filament_change', false, r.notify_operator OR r.notify_recipient OR r.role_id IS NOT NULL,
                    jsonb_build_array(jsonb_build_object('field', 'e.change', 'op', 'is', 'value', change.change)),
                    recipients, r.email, change.title, change.body);
            END LOOP;
        END IF;
    END LOOP;
END
$$;
-- +goose StatementEnd

SELECT pg_temp.seed_system_rule(
    'open_day_place_freed', 'Supervisor place freed',
    'Tells the supervisors who are not on an open day when a supervisor place on it becomes free.',
    'place_freed', false, true, '[]'::jsonb, '["free_supervisors"]'::jsonb, false, 'Supervisor place freed',
    'A supervisor place on the open day of {day}, {time}, is free.');
SELECT pg_temp.seed_system_rule(
    'open_day_period_open', 'Open day sign-up is open',
    'Tells everyone who staffs open days when sign-up for a period opens.',
    'period_opens', false, true, '[]'::jsonb, '["staffing_people"]'::jsonb, false, 'Open day sign-up is open',
    'You can now sign up for open days in {period}.');
SELECT pg_temp.seed_system_rule(
    'lab_rules_published', 'New Lab Rules',
    'Tells everyone who has to confirm the Lab Rules when a new version takes effect.',
    'lab_rules_published', true, true, '[]'::jsonb, '["need_confirm"]'::jsonb, true, 'New Lab Rules',
    'The Lab Rules {version} are now in effect. Please read and confirm them.');
SELECT pg_temp.seed_system_rule(
    'open_day_assigned_by_other', 'Signed up for an open day by someone else',
    'Tells a person when somebody else signs them up for an open day.',
    'open_day_assigned_by_other', false, true, '[]'::jsonb, '["self"]'::jsonb, true, 'You were assigned to an open day',
    'You were assigned to the {slots} {time} on the open day of {day}.');
SELECT pg_temp.seed_system_rule(
    'open_day_unassigned_by_other', 'Removed from an open day by someone else',
    'Tells a person when somebody else takes them off an open day.',
    'open_day_unassigned_by_other', false, true, '[]'::jsonb, '["self"]'::jsonb, true, 'You were removed from an open day',
    'You were removed from the {slots} {time} on the open day of {day}.');
SELECT pg_temp.seed_system_rule(
    'open_day_timeslot_changed', 'Open day times changed',
    'Tells a person when the times of a timeslot they staff changed.',
    'open_day_timeslot_changed', false, true, '[]'::jsonb, '["self"]'::jsonb, true, 'Your open day times changed',
    'Your {slots} on the open day of {day} {changed}: {time}.');
SELECT pg_temp.seed_system_rule(
    'open_day_timeslot_removed', 'Open day timeslot removed',
    'Tells a person when a timeslot they staffed was removed from the schedule.',
    'open_day_timeslot_removed', false, true, '[]'::jsonb, '["self"]'::jsonb, true, 'Your open day timeslot was removed',
    'The {slots} {time} on the open day of {day} {wasWere} removed from the schedule, so you are no longer assigned to {them}.');
SELECT pg_temp.seed_system_rule(
    'open_day_cancelled', 'Open day cancelled',
    'Tells a person when an open day they staffed was cancelled.',
    'open_day_cancelled', false, true, '[]'::jsonb, '["self"]'::jsonb, true, 'Open day cancelled',
    'The open day of {day}, where you were assigned ({time}), was cancelled.');

DROP TABLE printer_notification_rules;
DROP TABLE printer_notification_settings;

-- +goose Down
CREATE TABLE printer_notification_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO printer_notification_settings (singleton) VALUES (true);

CREATE TABLE printer_notification_rules (
    event text PRIMARY KEY CHECK (event IN ('printer_error', 'run_finished', 'filament_change')),
    notify_operator boolean NOT NULL DEFAULT true,
    notify_recipient boolean NOT NULL DEFAULT false,
    role_id uuid REFERENCES roles(id) ON DELETE SET NULL,
    email boolean NOT NULL DEFAULT false,
    min_severity text CHECK (min_severity IS NULL OR min_severity IN ('fatal', 'serious', 'common', 'info')),
    CHECK (event = 'printer_error' OR min_severity IS NULL)
);
INSERT INTO printer_notification_rules (event, notify_operator, min_severity)
VALUES ('printer_error', true, 'serious');
INSERT INTO printer_notification_rules (event, notify_operator) VALUES ('run_finished', true), ('filament_change', true);

DELETE FROM notification_rules WHERE system_key IN (
    'printer_error', 'run_finished', 'filament_loaded', 'filament_unloaded', 'filament_unknown_tag', 'filament_no_tag',
    'open_day_place_freed', 'open_day_period_open', 'lab_rules_published', 'open_day_assigned_by_other',
    'open_day_unassigned_by_other', 'open_day_timeslot_changed', 'open_day_timeslot_removed', 'open_day_cancelled'
);
