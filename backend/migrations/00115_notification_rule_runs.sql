-- +goose Up
-- Which run of a schedule rule was handled (an open day for the rules that run before or after each open day), so a
-- restart or a second scheduler pass never fires the same run twice.
CREATE TABLE notification_rule_runs (
    rule_id uuid NOT NULL REFERENCES notification_rules(id) ON DELETE CASCADE,
    run_key text NOT NULL CHECK (length(run_key) <= 200),
    ran_at timestamptz NOT NULL,
    PRIMARY KEY (rule_id, run_key)
);
CREATE INDEX notification_rule_runs_ran_at_idx ON notification_rule_runs (ran_at);

-- +goose Down
DROP TABLE notification_rule_runs;
