-- +goose Up
-- The Projektantrag of a working-group project (with its advance request, cost plan and planned purchases) becomes an
-- editable PDF template export. Without a stored version its built-in default is in effect, so no row is seeded.
ALTER TABLE pdf_template_versions
    DROP CONSTRAINT pdf_template_versions_export_kind_check,
    ADD CONSTRAINT pdf_template_versions_export_kind_check
        CHECK (export_kind IN ('wiref', 'cashbook', 'receipt', 'projektantrag'));

-- +goose Down
DELETE FROM pdf_template_versions WHERE export_kind = 'projektantrag';
ALTER TABLE pdf_template_versions
    DROP CONSTRAINT pdf_template_versions_export_kind_check,
    ADD CONSTRAINT pdf_template_versions_export_kind_check CHECK (export_kind IN ('wiref', 'cashbook', 'receipt'));
