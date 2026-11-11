-- +goose Up
-- An offer after a tap check-out names the tapped person and the check-out again, but only while it is open (at most
-- 15 minutes): it can then e-mail the survey to the person's own address, and an answer on the tablet keeps the
-- automatic e-mail of that check-out from following. Using the offer clears both, and the delivery loop deletes it once
-- it expires, exactly as for a self check-out offer. `after_tap` keeps the answers to such an offer anonymous whatever
-- the survey says, because anyone can tap any name.
ALTER TABLE survey_offers ADD COLUMN after_tap boolean NOT NULL DEFAULT false;
-- Open offers after a tap named nobody and cannot be completed under the new rule; they live 15 minutes at most.
DELETE FROM survey_offers WHERE consumed_at IS NULL AND person_id IS NULL;
ALTER TABLE survey_offers DROP CONSTRAINT survey_offers_open_person_check;
ALTER TABLE survey_offers ADD CONSTRAINT survey_offers_open_person_check
    CHECK (consumed_at IS NOT NULL OR (visit_id IS NOT NULL AND person_id IS NOT NULL));

-- +goose Down
ALTER TABLE survey_offers DROP CONSTRAINT survey_offers_open_person_check;
ALTER TABLE survey_offers ADD CONSTRAINT survey_offers_open_person_check
    CHECK (consumed_at IS NOT NULL OR (visit_id IS NULL) = (person_id IS NULL));
-- Open tap offers would read as self check-out offers without the column.
DELETE FROM survey_offers WHERE consumed_at IS NULL AND after_tap;
ALTER TABLE survey_offers DROP COLUMN after_tap;
