-- +goose Up
-- A ticket or a to-do may be linked to one purchase or one project of its group, for work that leads to buying
-- something. The group match is checked by the application. The links are set to NULL when the purchase or project is
-- deleted, so a task survives it.
ALTER TABLE working_group_tickets
    ADD COLUMN purchase_id uuid REFERENCES working_group_purchases(id) ON DELETE SET NULL,
    ADD COLUMN project_id uuid REFERENCES working_group_projects(id) ON DELETE SET NULL,
    ADD CONSTRAINT working_group_tickets_one_link CHECK (purchase_id IS NULL OR project_id IS NULL);

ALTER TABLE working_group_todos
    ADD COLUMN purchase_id uuid REFERENCES working_group_purchases(id) ON DELETE SET NULL,
    ADD COLUMN project_id uuid REFERENCES working_group_projects(id) ON DELETE SET NULL,
    ADD CONSTRAINT working_group_todos_one_link CHECK (purchase_id IS NULL OR project_id IS NULL);

CREATE INDEX working_group_tickets_purchase_idx ON working_group_tickets (purchase_id) WHERE purchase_id IS NOT NULL;
CREATE INDEX working_group_tickets_project_idx ON working_group_tickets (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX working_group_todos_purchase_idx ON working_group_todos (purchase_id) WHERE purchase_id IS NOT NULL;
CREATE INDEX working_group_todos_project_idx ON working_group_todos (project_id) WHERE project_id IS NOT NULL;

-- +goose Down
DROP INDEX working_group_todos_project_idx;
DROP INDEX working_group_todos_purchase_idx;
DROP INDEX working_group_tickets_project_idx;
DROP INDEX working_group_tickets_purchase_idx;
ALTER TABLE working_group_todos
    DROP CONSTRAINT working_group_todos_one_link, DROP COLUMN project_id, DROP COLUMN purchase_id;
ALTER TABLE working_group_tickets
    DROP CONSTRAINT working_group_tickets_one_link, DROP COLUMN project_id, DROP COLUMN purchase_id;
