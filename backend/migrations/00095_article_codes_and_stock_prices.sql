-- +goose Up
-- Material types get a short label code (used in spool labels) and a machine-use flag; articles get a display ID
-- (A-0001). The single sale price of an article is replaced by stock_article pricing rules, one rate per pricing
-- group; every former sale price becomes such a rule in every pricing group.

ALTER TABLE material_types
    ADD COLUMN code text,
    ADD COLUMN machine_use boolean;

-- The code is the first word of the name in upper case without other characters; repeated codes get a number.
-- +goose StatementBegin
DO $$
DECLARE
    t record;
    base text;
    candidate text;
    n integer;
BEGIN
    FOR t IN SELECT id, name FROM material_types ORDER BY created_at, id LOOP
        base := left(regexp_replace(upper(split_part(btrim(t.name), ' ', 1)), '[^A-Z0-9]', '', 'g'), 12);
        IF base = '' THEN
            base := 'TYPE';
        END IF;
        candidate := base;
        n := 1;
        WHILE EXISTS (SELECT 1 FROM material_types WHERE code = candidate) LOOP
            n := n + 1;
            candidate := left(base, 12 - length(n::text)) || n::text;
        END LOOP;
        UPDATE material_types SET code = candidate WHERE id = t.id;
    END LOOP;
END $$;
-- +goose StatementEnd

UPDATE material_types mt SET machine_use = (mt.kind = 'filament'
    OR EXISTS (SELECT 1 FROM pricing_rules r WHERE r.material_type_id = mt.id));

ALTER TABLE material_types
    ALTER COLUMN code SET NOT NULL,
    ALTER COLUMN machine_use SET NOT NULL,
    ALTER COLUMN machine_use SET DEFAULT true,
    ADD CONSTRAINT material_types_code_check CHECK (code ~ '^[A-Z0-9]{1,12}$'),
    ADD CONSTRAINT material_types_filament_machine_use_check CHECK (kind <> 'filament' OR machine_use);
CREATE UNIQUE INDEX material_types_code_ci_idx ON material_types (upper(code));

CREATE SEQUENCE material_display_sequence;
ALTER TABLE materials ADD COLUMN display_id text;
UPDATE materials m SET display_id = 'A-' || lpad(o.n::text, 4, '0')
FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM materials) o
WHERE o.id = m.id;
SELECT setval('material_display_sequence', GREATEST((SELECT count(*) FROM materials), 1), (SELECT count(*) FROM materials) > 0);
ALTER TABLE materials
    ALTER COLUMN display_id SET NOT NULL,
    ADD CONSTRAINT materials_display_id_check CHECK (display_id ~ '^A-[0-9]{4,}$'),
    ADD CONSTRAINT materials_display_id_key UNIQUE (display_id);

ALTER TABLE pricing_rules
    ADD COLUMN material_id uuid REFERENCES materials(id) ON DELETE CASCADE,
    DROP CONSTRAINT pricing_rules_kind_check,
    DROP CONSTRAINT pricing_rules_kind_selector_check,
    ADD CONSTRAINT pricing_rules_kind_check CHECK (kind IN ('machine_runtime', 'material', 'machine_measure', 'stock_article')),
    ADD CONSTRAINT pricing_rules_kind_selector_check CHECK (
        (kind = 'machine_runtime' AND process_id IS NOT NULL AND material_type_id IS NULL AND material_unit IS NULL
            AND measure IS NULL AND block_size IS NULL AND material_id IS NULL)
        OR (kind = 'material' AND process_id IS NULL AND material_type_id IS NOT NULL AND material_unit IS NOT NULL
            AND measure IS NULL AND block_size IS NULL AND material_id IS NULL)
        OR (kind = 'machine_measure' AND process_id IS NOT NULL AND material_type_id IS NULL AND material_unit IS NULL
            AND measure IS NOT NULL AND block_size IS NOT NULL AND material_id IS NULL)
        OR (kind = 'stock_article' AND process_id IS NULL AND material_type_id IS NULL AND material_unit IS NULL
            AND measure IS NULL AND block_size IS NULL AND material_id IS NOT NULL));
CREATE UNIQUE INDEX pricing_rules_active_stock_article_idx ON pricing_rules (pricing_group_id, material_id)
    WHERE active AND kind = 'stock_article';
CREATE INDEX pricing_rules_material_idx ON pricing_rules (material_id) WHERE material_id IS NOT NULL;

INSERT INTO pricing_rules (id, pricing_group_id, kind, material_id, rate, active)
SELECT uuidv7(), g.id, 'stock_article', m.id, m.sale_price, true
FROM materials m CROSS JOIN pricing_groups g
WHERE m.sale_price IS NOT NULL;

ALTER TABLE materials
    DROP CONSTRAINT materials_sale_price_check,
    DROP COLUMN sale_price;

-- +goose Down
ALTER TABLE materials ADD COLUMN sale_price numeric(20,6) CONSTRAINT materials_sale_price_check CHECK (sale_price IS NULL OR sale_price >= 0);
UPDATE materials m SET sale_price = (
    SELECT r.rate FROM pricing_rules r JOIN pricing_groups g ON g.id = r.pricing_group_id
    WHERE r.material_id = m.id AND r.kind = 'stock_article' AND r.active
    ORDER BY g.is_default DESC, r.rate DESC LIMIT 1);
DELETE FROM pricing_rules WHERE kind = 'stock_article';
DROP INDEX pricing_rules_material_idx;
DROP INDEX pricing_rules_active_stock_article_idx;
ALTER TABLE pricing_rules
    DROP CONSTRAINT pricing_rules_kind_selector_check,
    DROP CONSTRAINT pricing_rules_kind_check,
    DROP COLUMN material_id,
    ADD CONSTRAINT pricing_rules_kind_check CHECK (kind IN ('machine_runtime', 'material', 'machine_measure')),
    ADD CONSTRAINT pricing_rules_kind_selector_check CHECK (
        (kind = 'machine_runtime' AND process_id IS NOT NULL AND material_type_id IS NULL AND material_unit IS NULL AND measure IS NULL AND block_size IS NULL)
        OR (kind = 'material' AND process_id IS NULL AND material_type_id IS NOT NULL AND material_unit IS NOT NULL AND measure IS NULL AND block_size IS NULL)
        OR (kind = 'machine_measure' AND process_id IS NOT NULL AND material_type_id IS NULL AND material_unit IS NULL AND measure IS NOT NULL AND block_size IS NOT NULL));

ALTER TABLE materials
    DROP CONSTRAINT materials_display_id_key,
    DROP CONSTRAINT materials_display_id_check,
    DROP COLUMN display_id;
DROP SEQUENCE material_display_sequence;

DROP INDEX material_types_code_ci_idx;
ALTER TABLE material_types
    DROP CONSTRAINT material_types_filament_machine_use_check,
    DROP CONSTRAINT material_types_code_check,
    DROP COLUMN machine_use,
    DROP COLUMN code;
