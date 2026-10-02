-- +goose Up
ALTER TABLE accounts ALTER COLUMN status SET DEFAULT 'enabled';

-- +goose Down
ALTER TABLE accounts ALTER COLUMN status SET DEFAULT 'disabled';
