-- +goose Up
-- Fun dashboard greetings next to the time-of-day ones, with how often they appear.
ALTER TABLE branding_configuration
    ADD COLUMN fun_greetings text[] NOT NULL DEFAULT ARRAY[
        'Bogos binted?',
        'Hello there',
        'Ready to make something?',
        'The printers missed you'
    ]::text[],
    ADD COLUMN fun_greeting_share integer NOT NULL DEFAULT 10 CHECK (fun_greeting_share BETWEEN 0 AND 100);
ALTER TABLE branding_configuration
    ADD CONSTRAINT branding_configuration_fun_greetings_check
        CHECK (cardinality(fun_greetings) <= 50);

-- Printer errors and filament changes become notifications; a message may link to another site.
ALTER TABLE inbox_notifications DROP CONSTRAINT inbox_notifications_kind_check;
ALTER TABLE inbox_notifications
    ADD CONSTRAINT inbox_notifications_kind_check CHECK (kind IN (
        'message',
        'lab_rules_confirmation_requested',
        'open_day_period_open',
        'open_day_place_freed',
        'run_finished',
        'printer_error',
        'filament_change'
    ));
ALTER TABLE inbox_notifications DROP CONSTRAINT inbox_notifications_link_check;
ALTER TABLE inbox_notifications
    ADD CONSTRAINT inbox_notifications_link_check CHECK (
        link IS NULL OR (
            char_length(link) <= 500 AND (
                (link LIKE '/%' AND link NOT LIKE '//%') OR link LIKE 'https://%'
            )
        )
    );

-- +goose Down
DELETE FROM inbox_notifications WHERE kind IN ('printer_error', 'filament_change') OR link LIKE 'https://%';
ALTER TABLE inbox_notifications DROP CONSTRAINT inbox_notifications_link_check;
ALTER TABLE inbox_notifications
    ADD CONSTRAINT inbox_notifications_link_check
        CHECK (link IS NULL OR (link LIKE '/%' AND link NOT LIKE '//%' AND char_length(link) <= 500));
ALTER TABLE inbox_notifications DROP CONSTRAINT inbox_notifications_kind_check;
ALTER TABLE inbox_notifications
    ADD CONSTRAINT inbox_notifications_kind_check CHECK (kind IN (
        'message',
        'lab_rules_confirmation_requested',
        'open_day_period_open',
        'open_day_place_freed',
        'run_finished'
    ));
ALTER TABLE branding_configuration DROP CONSTRAINT branding_configuration_fun_greetings_check;
ALTER TABLE branding_configuration DROP COLUMN fun_greeting_share, DROP COLUMN fun_greetings;
