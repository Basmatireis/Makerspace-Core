-- +goose Up
ALTER TABLE open_day_periods ADD COLUMN sign_up_deadline date;

-- +goose Down
ALTER TABLE open_day_periods DROP COLUMN sign_up_deadline;
