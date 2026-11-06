-- +goose Up
-- Notifications written by the rule engine: they carry the rule, the firing and the category they belong to, so the
-- delivery log can point at them and a rule's notifications can be told apart from messages and system notices.
ALTER TABLE inbox_notifications DROP CONSTRAINT inbox_notifications_kind_check;
ALTER TABLE inbox_notifications
    ADD CONSTRAINT inbox_notifications_kind_check CHECK (kind IN (
        'message',
        'lab_rules_published',
        'open_day_period_open',
        'open_day_place_freed',
        'open_day_timeslot_changed',
        'open_day_timeslot_removed',
        'open_day_cancelled',
        'open_day_assigned_by_other',
        'open_day_unassigned_by_other',
        'run_finished',
        'printer_error',
        'filament_change',
        'rule'
    ));
ALTER TABLE inbox_notifications
    ADD COLUMN rule_id uuid REFERENCES notification_rules(id) ON DELETE SET NULL,
    ADD COLUMN firing_id uuid REFERENCES notification_firings(id) ON DELETE SET NULL,
    ADD COLUMN category_id uuid REFERENCES notification_categories(id) ON DELETE SET NULL,
    ADD CONSTRAINT inbox_notifications_rule_columns_check
        CHECK (kind = 'rule' OR (rule_id IS NULL AND firing_id IS NULL AND category_id IS NULL));
CREATE INDEX inbox_notifications_firing_idx ON inbox_notifications (firing_id) WHERE firing_id IS NOT NULL;
CREATE INDEX inbox_notifications_rule_idx ON inbox_notifications (rule_id) WHERE rule_id IS NOT NULL;

ALTER TABLE notification_mail_outbox DROP CONSTRAINT notification_mail_outbox_kind_check;
ALTER TABLE notification_mail_outbox
    ADD CONSTRAINT notification_mail_outbox_kind_check CHECK (kind IN (
        'printer_error',
        'run_finished',
        'filament_change',
        'lab_rules_published',
        'open_day_timeslot_changed',
        'open_day_timeslot_removed',
        'open_day_cancelled',
        'open_day_assigned_by_other',
        'open_day_unassigned_by_other',
        'rule'
    ));
ALTER TABLE notification_mail_outbox
    ADD COLUMN firing_id uuid REFERENCES notification_firings(id) ON DELETE SET NULL;

-- +goose Down
DELETE FROM notification_mail_outbox WHERE kind = 'rule';
ALTER TABLE notification_mail_outbox DROP COLUMN firing_id;
ALTER TABLE notification_mail_outbox DROP CONSTRAINT notification_mail_outbox_kind_check;
ALTER TABLE notification_mail_outbox
    ADD CONSTRAINT notification_mail_outbox_kind_check CHECK (kind IN (
        'printer_error',
        'run_finished',
        'filament_change',
        'lab_rules_published',
        'open_day_timeslot_changed',
        'open_day_timeslot_removed',
        'open_day_cancelled',
        'open_day_assigned_by_other',
        'open_day_unassigned_by_other'
    ));

DELETE FROM inbox_notifications WHERE kind = 'rule';
DROP INDEX inbox_notifications_rule_idx;
DROP INDEX inbox_notifications_firing_idx;
ALTER TABLE inbox_notifications
    DROP CONSTRAINT inbox_notifications_rule_columns_check,
    DROP COLUMN category_id,
    DROP COLUMN firing_id,
    DROP COLUMN rule_id;
ALTER TABLE inbox_notifications DROP CONSTRAINT inbox_notifications_kind_check;
ALTER TABLE inbox_notifications
    ADD CONSTRAINT inbox_notifications_kind_check CHECK (kind IN (
        'message',
        'lab_rules_published',
        'open_day_period_open',
        'open_day_place_freed',
        'open_day_timeslot_changed',
        'open_day_timeslot_removed',
        'open_day_cancelled',
        'open_day_assigned_by_other',
        'open_day_unassigned_by_other',
        'run_finished',
        'printer_error',
        'filament_change'
    ));
