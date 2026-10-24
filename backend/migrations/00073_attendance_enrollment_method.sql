-- +goose Up
-- Completing visitor enrollment on the terminal counts as arriving: the check-in method 'enrollment' marks visits and
-- holds that were created together with the new account.
ALTER TABLE attendance_holds DROP CONSTRAINT attendance_holds_check_in_method_check;
ALTER TABLE attendance_holds ADD CONSTRAINT attendance_holds_check_in_method_check
    CHECK (check_in_method IN ('password', 'pin', 'oidc', 'nfc', 'supervisor', 'enrollment'));
ALTER TABLE visits DROP CONSTRAINT visits_check_in_method_check;
ALTER TABLE visits ADD CONSTRAINT visits_check_in_method_check
    CHECK (check_in_method IN ('password', 'pin', 'oidc', 'nfc', 'supervisor', 'enrollment'));

-- +goose Down
-- Enrollment check-ins were not authenticated by a credential at the terminal; they become 'supervisor' check-ins
-- (the closest remaining method for an unattended entry) so the narrower constraint can be restored.
UPDATE attendance_holds SET check_in_method = 'supervisor' WHERE check_in_method = 'enrollment';
UPDATE visits SET check_in_method = 'supervisor' WHERE check_in_method = 'enrollment';
ALTER TABLE attendance_holds DROP CONSTRAINT attendance_holds_check_in_method_check;
ALTER TABLE attendance_holds ADD CONSTRAINT attendance_holds_check_in_method_check
    CHECK (check_in_method IN ('password', 'pin', 'oidc', 'nfc', 'supervisor'));
ALTER TABLE visits DROP CONSTRAINT visits_check_in_method_check;
ALTER TABLE visits ADD CONSTRAINT visits_check_in_method_check
    CHECK (check_in_method IN ('password', 'pin', 'oidc', 'nfc', 'supervisor'));
