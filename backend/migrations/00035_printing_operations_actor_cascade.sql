-- +goose Up
-- Printing operation keys only make retried requests idempotent. They must
-- not keep a deleted Account (and therefore its Person) from being removed.
ALTER TABLE printing_operations
    DROP CONSTRAINT printing_operations_actor_account_id_fkey,
    ADD CONSTRAINT printing_operations_actor_account_id_fkey
        FOREIGN KEY (actor_account_id) REFERENCES accounts(id) ON DELETE CASCADE;

-- +goose Down
ALTER TABLE printing_operations
    DROP CONSTRAINT printing_operations_actor_account_id_fkey,
    ADD CONSTRAINT printing_operations_actor_account_id_fkey
        FOREIGN KEY (actor_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
