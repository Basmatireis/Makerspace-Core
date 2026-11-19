-- +goose Up
-- Pinboard notes and the usability status of the machines and places a working group looks after.
--
-- A note is a short text pinned by a person: to one group (visible inside that group only), publicly for a group
-- (visible to everybody who may read working groups) or for the whole makerspace (group_id is NULL, always public).
-- The author reference is SET NULL so a note survives the deletion of its author.
CREATE TABLE working_group_notes (
    id uuid PRIMARY KEY,
    group_id uuid REFERENCES working_groups(id) ON DELETE CASCADE,
    is_public boolean NOT NULL,
    text text NOT NULL CHECK (text = btrim(text) AND text <> '' AND length(text) <= 500),
    author_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- A makerspace note has no group to hide it in.
    CHECK (group_id IS NOT NULL OR is_public)
);

CREATE INDEX working_group_notes_created_idx ON working_group_notes (created_at DESC, id DESC);
CREATE INDEX working_group_notes_group_idx ON working_group_notes (group_id, created_at DESC) WHERE group_id IS NOT NULL;
CREATE INDEX working_group_notes_author_idx ON working_group_notes (author_person_id) WHERE author_person_id IS NOT NULL;

-- The current status lives on the rows of the assigned machines and the places. A machine that leaves its group is
-- deleted from working_group_machines, so its status is back to ok when it is assigned again.
ALTER TABLE working_group_machines
    ADD COLUMN status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'limited', 'maintenance', 'out_of_order')),
    ADD COLUMN status_note text CHECK (status_note IS NULL OR (status_note = btrim(status_note) AND status_note <> '' AND length(status_note) <= 200)),
    ADD COLUMN status_until date,
    ADD COLUMN status_changed_at timestamptz,
    ADD COLUMN status_changed_by uuid REFERENCES people(id) ON DELETE SET NULL,
    ADD CONSTRAINT working_group_machines_status_ok_bare CHECK (status <> 'ok' OR (status_note IS NULL AND status_until IS NULL));

ALTER TABLE working_group_places
    ADD COLUMN status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'limited', 'maintenance', 'out_of_order')),
    ADD COLUMN status_note text CHECK (status_note IS NULL OR (status_note = btrim(status_note) AND status_note <> '' AND length(status_note) <= 200)),
    ADD COLUMN status_until date,
    ADD COLUMN status_changed_at timestamptz,
    ADD COLUMN status_changed_by uuid REFERENCES people(id) ON DELETE SET NULL,
    ADD CONSTRAINT working_group_places_status_ok_bare CHECK (status <> 'ok' OR (status_note IS NULL AND status_until IS NULL));

CREATE INDEX working_group_machines_status_changed_by_idx ON working_group_machines (status_changed_by) WHERE status_changed_by IS NOT NULL;
CREATE INDEX working_group_places_status_changed_by_idx ON working_group_places (status_changed_by) WHERE status_changed_by IS NOT NULL;

-- One row per status change of a machine or a place, so the pages can show on how many days an item was not ok.
-- Exactly one of machine_id and place_id is set; deleting the item (or the group) deletes its history.
CREATE TABLE working_group_status_changes (
    id uuid PRIMARY KEY,
    group_id uuid NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,
    machine_id uuid REFERENCES machines(id) ON DELETE CASCADE,
    place_id uuid REFERENCES working_group_places(id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('ok', 'limited', 'maintenance', 'out_of_order')),
    changed_at timestamptz NOT NULL,
    changed_by_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
    CHECK (num_nonnulls(machine_id, place_id) = 1)
);

CREATE INDEX working_group_status_changes_machine_idx ON working_group_status_changes (machine_id, changed_at) WHERE machine_id IS NOT NULL;
CREATE INDEX working_group_status_changes_place_idx ON working_group_status_changes (place_id, changed_at) WHERE place_id IS NOT NULL;
CREATE INDEX working_group_status_changes_group_idx ON working_group_status_changes (group_id);
CREATE INDEX working_group_status_changes_person_idx ON working_group_status_changes (changed_by_person_id) WHERE changed_by_person_id IS NOT NULL;

-- +goose Down
-- Destructive: every pinboard note, every machine and place status and the status history are deleted.
DROP TABLE working_group_status_changes;
DROP INDEX working_group_places_status_changed_by_idx;
DROP INDEX working_group_machines_status_changed_by_idx;
ALTER TABLE working_group_places
    DROP CONSTRAINT working_group_places_status_ok_bare,
    DROP COLUMN status_changed_by,
    DROP COLUMN status_changed_at,
    DROP COLUMN status_until,
    DROP COLUMN status_note,
    DROP COLUMN status;
ALTER TABLE working_group_machines
    DROP CONSTRAINT working_group_machines_status_ok_bare,
    DROP COLUMN status_changed_by,
    DROP COLUMN status_changed_at,
    DROP COLUMN status_until,
    DROP COLUMN status_note,
    DROP COLUMN status;
DROP TABLE working_group_notes;
