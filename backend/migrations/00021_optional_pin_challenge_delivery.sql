-- +goose Up
ALTER TABLE auth_challenges
    DROP CONSTRAINT auth_challenges_delivery_address_check,
    ALTER COLUMN delivery_address DROP NOT NULL,
    ADD CONSTRAINT auth_challenges_delivery_address_check CHECK (
        CASE
            WHEN delivery_address IS NULL THEN kind = 'pin_enrollment'
            ELSE delivery_address = btrim(delivery_address)
                AND delivery_address <> ''
                AND length(delivery_address) <= 254
        END
    );

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM auth_challenges WHERE delivery_address IS NULL) THEN
        RAISE EXCEPTION 'cannot downgrade while PIN challenges without a delivery address exist';
    END IF;
END $$;
-- +goose StatementEnd

ALTER TABLE auth_challenges
    DROP CONSTRAINT auth_challenges_delivery_address_check,
    ALTER COLUMN delivery_address SET NOT NULL,
    ADD CONSTRAINT auth_challenges_delivery_address_check CHECK (
        delivery_address = btrim(delivery_address)
        AND delivery_address <> ''
        AND length(delivery_address) <= 254
    );
