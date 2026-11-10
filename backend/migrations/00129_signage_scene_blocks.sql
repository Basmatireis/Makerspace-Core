-- +goose Up
-- Digital signage: scenes are made of freely positioned blocks instead of a layout with one widget per zone; the
-- built-in and the custom layouts are gone. Every scene is converted so that it renders exactly as before. The same
-- rules convert publications made before this migration when they are read (backend/internal/signage/convert.go);
-- TestSignageBlocksMigrationMatchesGoConversion keeps both equal, so change neither without the other.
--
-- A scene is laid out on a grid whose short side is 1080 units; the old unit u (1 % of the short side) is 10.8
-- units. Each zone becomes one block in layout order with the zone's box (edges rounded so that blocks tile), the
-- zone id and label, and the widget without its zone style, which moves into the block style. Scene versions are
-- kept: a converted draft equals its converted publication, so no display reports a pending change.

ALTER TABLE signage_scenes
    ADD COLUMN blocks jsonb NOT NULL DEFAULT '[]'::jsonb CONSTRAINT signage_scenes_blocks_check CHECK (jsonb_typeof(blocks) = 'array');

-- +goose StatementBegin
-- n / d rounded half up (d > 0); integer division truncates towards zero like Go's.
CREATE FUNCTION signage_00129_round_div(n bigint, d bigint) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT ((2 * n + d) / (2 * d))::integer $$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION signage_00129_clamp(value integer, low integer, high integer) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT least(greatest(value, low), high) $$;
-- +goose StatementEnd

-- +goose StatementBegin
-- The text of a JSON string, '' for anything else.
CREATE FUNCTION signage_00129_str(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN jsonb_typeof(value) = 'string' THEN value #>> '{}' ELSE '' END $$;
-- +goose StatementEnd

-- +goose StatementBegin
-- The grid lines of fr-weighted tracks across total units (1-based: lines[1] = 0).
CREATE FUNCTION signage_00129_edges(total integer, weights integer[]) RETURNS integer[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    tracks integer[] := CASE WHEN coalesce(cardinality(weights), 0) = 0 THEN ARRAY[1] ELSE weights END;
    weight_sum integer := 0;
    running integer := 0;
    lines integer[] := ARRAY[0];
    weight integer;
BEGIN
    FOREACH weight IN ARRAY tracks LOOP
        weight_sum := weight_sum + weight;
    END LOOP;
    IF weight_sum < 1 THEN
        weight_sum := 1;
    END IF;
    FOREACH weight IN ARRAY tracks LOOP
        running := running + weight;
        lines := lines || signage_00129_round_div(total::bigint * running, weight_sum);
    END LOOP;
    RETURN lines;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
-- The nine built-in layouts in the shape of a custom grid layout; an unknown id rendered as full.
CREATE FUNCTION signage_00129_builtin_layout(layout_id text) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
SELECT coalesce(layouts -> layout_id, layouts -> 'full') FROM (SELECT '{
  "full": {"columns": [1], "rows": [1], "zones": [
    {"id": "main", "label": "Main", "grid": {"col": 1, "row": 1, "colSpan": 1, "rowSpan": 1}}]},
  "stack3": {"columns": [1], "rows": [14, 72, 14], "zones": [
    {"id": "header", "label": "Header", "grid": {"col": 1, "row": 1, "colSpan": 1, "rowSpan": 1}},
    {"id": "main", "label": "Main", "grid": {"col": 1, "row": 2, "colSpan": 1, "rowSpan": 1}},
    {"id": "footer", "label": "Footer", "grid": {"col": 1, "row": 3, "colSpan": 1, "rowSpan": 1}}]},
  "stack4": {"columns": [1], "rows": [10, 52, 24, 14], "zones": [
    {"id": "header", "label": "Header", "grid": {"col": 1, "row": 1, "colSpan": 1, "rowSpan": 1}},
    {"id": "main", "label": "Main", "grid": {"col": 1, "row": 2, "colSpan": 1, "rowSpan": 1}},
    {"id": "info", "label": "Info", "grid": {"col": 1, "row": 3, "colSpan": 1, "rowSpan": 1}},
    {"id": "footer", "label": "Footer", "grid": {"col": 1, "row": 4, "colSpan": 1, "rowSpan": 1}}]},
  "split": {"columns": [1, 1], "rows": [1], "zones": [
    {"id": "left", "label": "Left", "grid": {"col": 1, "row": 1, "colSpan": 1, "rowSpan": 1}},
    {"id": "right", "label": "Right", "grid": {"col": 2, "row": 1, "colSpan": 1, "rowSpan": 1}}]},
  "grid2x2": {"columns": [1, 1], "rows": [1, 1], "zones": [
    {"id": "tl", "label": "Top left", "grid": {"col": 1, "row": 1, "colSpan": 1, "rowSpan": 1}},
    {"id": "tr", "label": "Top right", "grid": {"col": 2, "row": 1, "colSpan": 1, "rowSpan": 1}},
    {"id": "bl", "label": "Bottom left", "grid": {"col": 1, "row": 2, "colSpan": 1, "rowSpan": 1}},
    {"id": "br", "label": "Bottom right", "grid": {"col": 2, "row": 2, "colSpan": 1, "rowSpan": 1}}]},
  "quad_banner": {"columns": [1, 1], "rows": [44, 44, 12], "zones": [
    {"id": "tl", "label": "Top left", "grid": {"col": 1, "row": 1, "colSpan": 1, "rowSpan": 1}},
    {"id": "tr", "label": "Top right", "grid": {"col": 2, "row": 1, "colSpan": 1, "rowSpan": 1}},
    {"id": "bl", "label": "Bottom left", "grid": {"col": 1, "row": 2, "colSpan": 1, "rowSpan": 1}},
    {"id": "br", "label": "Bottom right", "grid": {"col": 2, "row": 2, "colSpan": 1, "rowSpan": 1}},
    {"id": "banner", "label": "Banner", "grid": {"col": 1, "row": 3, "colSpan": 2, "rowSpan": 1}}]},
  "main_side": {"columns": [2, 1], "rows": [1, 1], "zones": [
    {"id": "main", "label": "Main", "grid": {"col": 1, "row": 1, "colSpan": 1, "rowSpan": 2}},
    {"id": "side_top", "label": "Sidebar top", "grid": {"col": 2, "row": 1, "colSpan": 1, "rowSpan": 1}},
    {"id": "side_bottom", "label": "Sidebar bottom", "grid": {"col": 2, "row": 2, "colSpan": 1, "rowSpan": 1}}]},
  "main_footer": {"columns": [1], "rows": [92, 8], "zones": [
    {"id": "main", "label": "Main", "grid": {"col": 1, "row": 1, "colSpan": 1, "rowSpan": 1}},
    {"id": "footer", "label": "Footer", "grid": {"col": 1, "row": 2, "colSpan": 1, "rowSpan": 1}}]},
  "banner_main": {"columns": [1], "rows": [16, 84], "zones": [
    {"id": "banner", "label": "Banner", "grid": {"col": 1, "row": 1, "colSpan": 1, "rowSpan": 1}},
    {"id": "main", "label": "Main", "grid": {"col": 1, "row": 2, "colSpan": 1, "rowSpan": 1}}]}
}'::jsonb AS layouts) builtin
$$;
-- +goose StatementEnd

-- +goose StatementBegin
-- The zones of a grid layout as boxes {id, label, x, y, w, h} in grid units; placements are clamped to the tracks.
CREATE FUNCTION signage_00129_grid_zones(grid_w integer, grid_h integer, columns integer[], rows integer[], zones jsonb)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    col_lines integer[] := signage_00129_edges(grid_w, columns);
    row_lines integer[] := signage_00129_edges(grid_h, rows);
    col_count integer := cardinality(col_lines) - 1;
    row_count integer := cardinality(row_lines) - 1;
    placed jsonb := '[]'::jsonb;
    zone jsonb;
    place jsonb;
    col integer;
    row_index integer;
    col_span integer;
    row_span integer;
BEGIN
    FOR zone IN SELECT e.value FROM jsonb_array_elements(zones) WITH ORDINALITY AS e(value, n) ORDER BY e.n LOOP
        place := CASE WHEN jsonb_typeof(zone -> 'grid') = 'object' THEN zone -> 'grid'
            ELSE '{"col": 1, "row": 1, "colSpan": 1, "rowSpan": 1}'::jsonb END;
        col := signage_00129_clamp(coalesce((place ->> 'col')::integer, 0), 1, col_count);
        row_index := signage_00129_clamp(coalesce((place ->> 'row')::integer, 0), 1, row_count);
        col_span := signage_00129_clamp(coalesce((place ->> 'colSpan')::integer, 0), 1, col_count - col + 1);
        row_span := signage_00129_clamp(coalesce((place ->> 'rowSpan')::integer, 0), 1, row_count - row_index + 1);
        placed := placed || jsonb_build_array(jsonb_build_object(
            'id', coalesce(zone ->> 'id', ''),
            'label', coalesce(zone ->> 'label', ''),
            'x', col_lines[col],
            'y', row_lines[row_index],
            'w', col_lines[col + col_span] - col_lines[col],
            'h', row_lines[row_index + row_span] - row_lines[row_index]));
    END LOOP;
    RETURN placed;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
-- A percentage in hundredths, rounded half away from zero and clamped to 0–100 %; fallback when not a number.
CREATE FUNCTION signage_00129_hundredths(value jsonb, fallback integer) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
SELECT CASE WHEN jsonb_typeof(value) = 'number'
    THEN least(greatest(round((value #>> '{}')::numeric * 100), 0), 10000)::integer
    ELSE fallback END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
-- The zones of a free layout (percent rectangles) as boxes in grid units.
CREATE FUNCTION signage_00129_free_zones(grid_w integer, grid_h integer, zones jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    placed jsonb := '[]'::jsonb;
    zone jsonb;
    rect jsonb;
    x integer;
    y integer;
    w integer;
    h integer;
    box_left integer;
    box_top integer;
BEGIN
    FOR zone IN SELECT e.value FROM jsonb_array_elements(zones) WITH ORDINALITY AS e(value, n) ORDER BY e.n LOOP
        rect := CASE WHEN jsonb_typeof(zone -> 'rect') = 'object' THEN zone -> 'rect'
            ELSE '{"x": 0, "y": 0, "width": 100, "height": 100}'::jsonb END;
        x := signage_00129_hundredths(rect -> 'x', 0);
        y := signage_00129_hundredths(rect -> 'y', 0);
        w := signage_00129_hundredths(rect -> 'width', 10000);
        h := signage_00129_hundredths(rect -> 'height', 10000);
        box_left := signage_00129_round_div(grid_w::bigint * x, 10000);
        box_top := signage_00129_round_div(grid_h::bigint * y, 10000);
        placed := placed || jsonb_build_array(jsonb_build_object(
            'id', coalesce(zone ->> 'id', ''),
            'label', coalesce(zone ->> 'label', ''),
            'x', box_left,
            'y', box_top,
            'w', signage_00129_round_div(grid_w::bigint * (x + w), 10000) - box_left,
            'h', signage_00129_round_div(grid_h::bigint * (y + h), 10000) - box_top));
    END LOOP;
    RETURN placed;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
-- One zone with its widget as a block: the zone style moves into a block style that reproduces the old look, and
-- the widget's own fields are adapted (text loses size and align and gains fit, announcements lose size, cameras
-- show the live badge and the name, images are not dimmed). Anything that is not a widget object becomes empty.
CREATE FUNCTION signage_00129_block(zone jsonb, stored jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    widget jsonb := stored;
    kind text;
    style_key text;
    zone_style jsonb;
    font_scale integer;
    rich boolean;
    padding integer;
    text_size integer;
    family text := 'inherit';
    font_asset jsonb := 'null'::jsonb;
    font_weight text := 'inherit';
    line_height integer := 125;
    zone_align text;
    zone_vertical text;
    align text;
    vertical text;
    block_id text;
    block_name text;
BEGIN
    IF jsonb_typeof(widget) IS DISTINCT FROM 'object' OR signage_00129_str(widget -> 'type') = '' THEN
        widget := '{"type": "empty"}'::jsonb;
    END IF;
    kind := signage_00129_str(widget -> 'type');
    style_key := CASE WHEN kind = 'announcement' THEN 'boxStyle' ELSE 'style' END;
    zone_style := CASE WHEN jsonb_typeof(widget -> style_key) = 'object' THEN widget -> style_key END;
    widget := widget - style_key;

    font_scale := coalesce((zone_style ->> 'fontScale')::integer, 100);
    rich := signage_00129_str(widget -> 'format') NOT IN ('', 'plain');
    -- A zone without a style kept the renderer's default 2u padding; a style replaced it, even with 0.
    IF zone_style IS NOT NULL THEN
        padding := signage_00129_clamp(signage_00129_round_div(coalesce((zone_style ->> 'padding')::integer, 0) * 108, 10), 0, 400);
    ELSIF kind IN ('text', 'status', 'clock', 'open_days', 'events', 'agenda', 'calendar', 'qr') THEN
        padding := 22;
    ELSE
        padding := 0;
    END IF;
    IF zone_style ->> 'fontFamily' = 'custom' AND jsonb_typeof(zone_style -> 'fontAssetId') = 'string' THEN
        family := 'custom';
        font_asset := zone_style -> 'fontAssetId';
    ELSIF zone_style ->> 'fontFamily' IN ('sans', 'serif', 'mono') THEN
        family := zone_style ->> 'fontFamily';
    END IF;
    IF kind IN ('text', 'announcement') THEN
        text_size := signage_00129_round_div(
            (CASE signage_00129_str(widget -> 'size') WHEN 's' THEN 30 WHEN 'l' THEN 70 WHEN 'xl' THEN 100 ELSE 46 END)::bigint
                * 108 * font_scale,
            10000);
    ELSE
        text_size := signage_00129_round_div(32::bigint * font_scale, 100);
    END IF;
    text_size := signage_00129_clamp(text_size, 8, 400);
    IF kind = 'text' AND NOT rich THEN
        font_weight := '600';
        line_height := 115;
    ELSIF kind = 'text' THEN
        line_height := 130;
    ELSIF kind = 'announcement' THEN
        line_height := 115;
    END IF;
    -- Clocks, QR codes and full-screen announcements were always centred; the zone style aligned the rest.
    zone_align := coalesce(zone_style ->> 'align', '');
    align := CASE
        WHEN kind IN ('clock', 'qr') THEN 'center'
        WHEN kind = 'announcement' AND signage_00129_str(widget -> 'style') = 'full' THEN 'center'
        WHEN zone_align IN ('start', 'center', 'end') THEN zone_align
        WHEN kind = 'text' AND signage_00129_str(widget -> 'align') IN ('start', 'center', 'end') THEN signage_00129_str(widget -> 'align')
        ELSE 'start' END;
    zone_vertical := coalesce(zone_style ->> 'verticalAlign', '');
    vertical := CASE
        WHEN zone_vertical IN ('start', 'center', 'end') THEN zone_vertical
        WHEN kind IN ('text', 'clock', 'qr', 'status', 'announcement', 'camera') THEN 'center'
        ELSE 'start' END;

    IF kind = 'text' THEN
        widget := (widget - 'size' - 'align') || '{"fit": false}'::jsonb;
    ELSIF kind = 'announcement' THEN
        widget := widget - 'size';
    ELSIF kind = 'camera' THEN
        widget := widget || '{"showLive": true, "showName": true}'::jsonb;
    ELSIF kind = 'image' THEN
        widget := widget || '{"dim": 0}'::jsonb;
    END IF;

    block_id := left(regexp_replace(zone ->> 'id', '[^A-Za-z0-9_-]', '_', 'g'), 40);
    IF block_id = '' THEN
        block_id := 'block';
    END IF;
    block_name := left(btrim(zone ->> 'label', ' '), 60);
    IF block_name = '' THEN
        block_name := block_id;
    END IF;
    RETURN jsonb_build_object(
        'id', block_id,
        'name', block_name,
        'x', signage_00129_clamp((zone ->> 'x')::integer, -8000, 8000),
        'y', signage_00129_clamp((zone ->> 'y')::integer, -8000, 8000),
        'w', signage_00129_clamp((zone ->> 'w')::integer, 8, 8000),
        'h', signage_00129_clamp((zone ->> 'h')::integer, 8, 8000),
        'hidden', false,
        'locked', false,
        'widget', widget,
        'style', jsonb_build_object(
            'backgroundColor', CASE WHEN jsonb_typeof(zone_style -> 'backgroundColor') = 'string' THEN zone_style -> 'backgroundColor' ELSE 'null'::jsonb END,
            'backgroundOpacity', signage_00129_clamp(coalesce((zone_style ->> 'backgroundOpacity')::integer, 100), 0, 100),
            'backgroundAssetId', NULL,
            'backgroundDim', 0,
            'textColor', CASE WHEN jsonb_typeof(zone_style -> 'textColor') = 'string' THEN zone_style -> 'textColor' ELSE 'null'::jsonb END,
            'borderWidth', signage_00129_clamp(signage_00129_round_div(coalesce((zone_style ->> 'borderWidth')::integer, 0) * 108, 100), 0, 40),
            'borderStyle', 'solid',
            'borderColor', CASE WHEN jsonb_typeof(zone_style -> 'borderColor') = 'string' THEN zone_style -> 'borderColor' ELSE 'null'::jsonb END,
            'radius', signage_00129_clamp(signage_00129_round_div(coalesce((zone_style ->> 'radius')::integer, 0) * 108, 10), 0, 400),
            'shadow', 'none',
            'fontFamily', family,
            'fontAssetId', font_asset,
            'fontWeight', font_weight,
            'lineHeight', line_height,
            'letterSpacing', 0,
            'uppercase', false,
            'textSize', text_size,
            'padding', padding,
            'align', align,
            'verticalAlign', vertical,
            'opacity', 100));
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
-- The blocks of a scene: its layout's zones in order (free layouts: the stacking order), empty zones included. A
-- scene on a missing or empty custom layout, like one with an unknown layout id, rendered as full.
CREATE FUNCTION signage_00129_scene_blocks(
    aspect_w integer,
    aspect_h integer,
    layout_id text,
    custom_mode text,
    custom_columns integer[],
    custom_rows integer[],
    custom_zones jsonb,
    zones jsonb
) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    grid_w integer;
    grid_h integer;
    builtin jsonb;
    placed jsonb;
    blocks jsonb := '[]'::jsonb;
    zone jsonb;
BEGIN
    IF aspect_w < 1 OR aspect_h < 1 THEN
        aspect_w := 16;
        aspect_h := 9;
    END IF;
    IF aspect_w >= aspect_h THEN
        grid_w := signage_00129_round_div(1080::bigint * aspect_w, aspect_h);
        grid_h := 1080;
    ELSE
        grid_w := 1080;
        grid_h := signage_00129_round_div(1080::bigint * aspect_h, aspect_w);
    END IF;
    IF layout_id = 'custom' AND jsonb_typeof(custom_zones) = 'array' AND jsonb_array_length(custom_zones) > 0 THEN
        IF custom_mode = 'free' THEN
            placed := signage_00129_free_zones(grid_w, grid_h, custom_zones);
        ELSE
            placed := signage_00129_grid_zones(grid_w, grid_h, custom_columns, custom_rows, custom_zones);
        END IF;
    ELSE
        builtin := signage_00129_builtin_layout(layout_id);
        placed := signage_00129_grid_zones(
            grid_w,
            grid_h,
            ARRAY(SELECT e.value::integer FROM jsonb_array_elements_text(builtin -> 'columns') WITH ORDINALITY AS e(value, n) ORDER BY e.n),
            ARRAY(SELECT e.value::integer FROM jsonb_array_elements_text(builtin -> 'rows') WITH ORDINALITY AS e(value, n) ORDER BY e.n),
            builtin -> 'zones');
    END IF;
    FOR zone IN SELECT e.value FROM jsonb_array_elements(placed) WITH ORDINALITY AS e(value, n) ORDER BY e.n LOOP
        blocks := blocks || jsonb_build_array(signage_00129_block(
            zone,
            coalesce(zones -> (zone ->> 'id'), '{"type": "empty"}'::jsonb)));
    END LOOP;
    RETURN blocks;
END
$$;
-- +goose StatementEnd

UPDATE signage_scenes s
SET blocks = signage_00129_scene_blocks(
    s.aspect_width, s.aspect_height, s.layout_id, l.mode, l.columns, l.rows, l.zones, s.zones)
FROM signage_scenes source LEFT JOIN signage_custom_layouts l ON l.id = source.custom_layout_id
WHERE source.id = s.id;

DROP FUNCTION signage_00129_scene_blocks(integer, integer, text, text, integer[], integer[], jsonb, jsonb);
DROP FUNCTION signage_00129_block(jsonb, jsonb);
DROP FUNCTION signage_00129_free_zones(integer, integer, jsonb);
DROP FUNCTION signage_00129_hundredths(jsonb, integer);
DROP FUNCTION signage_00129_grid_zones(integer, integer, integer[], integer[], jsonb);
DROP FUNCTION signage_00129_builtin_layout(text);
DROP FUNCTION signage_00129_edges(integer, integer[]);
DROP FUNCTION signage_00129_str(jsonb);
DROP FUNCTION signage_00129_clamp(integer, integer, integer);
DROP FUNCTION signage_00129_round_div(bigint, bigint);

-- Layouts and zones are replaced by the blocks converted above; Down cannot restore them.
DROP INDEX signage_scenes_custom_layout_idx;
ALTER TABLE signage_scenes DROP CONSTRAINT signage_scenes_custom_layout_check;
-- squawk-ignore ban-drop-column
ALTER TABLE signage_scenes DROP COLUMN custom_layout_id, DROP COLUMN layout_id, DROP COLUMN zones;
-- Custom layouts are gone with the layouts; their zones live on as the blocks of the scenes that used them.
-- squawk-ignore ban-drop-table
DROP TABLE signage_custom_layouts;

-- +goose Down
-- Lossy: layouts and block styles cannot be restored. Every scene gets the full-screen layout showing the widget of
-- its first visible block that is not empty (in the older widget shape, without a style), or an empty one. The
-- custom layouts table comes back empty.
CREATE TABLE signage_custom_layouts (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 100),
    mode text NOT NULL CHECK (mode IN ('grid', 'free')),
    -- Grid track weights in fr; free layouts store {1} / {1}.
    columns integer[] NOT NULL CHECK (cardinality(columns) BETWEEN 1 AND 12 AND 1 <= ALL (columns) AND 100 >= ALL (columns)),
    rows integer[] NOT NULL CHECK (cardinality(rows) BETWEEN 1 AND 12 AND 1 <= ALL (rows) AND 100 >= ALL (rows)),
    -- Ordered zones; the Go service validates ids, bounds and overlaps.
    zones jsonb NOT NULL CHECK (jsonb_typeof(zones) = 'array' AND jsonb_array_length(zones) BETWEEN 1 AND 12),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signage_custom_layouts_name_idx ON signage_custom_layouts (lower(name), id);

ALTER TABLE signage_scenes
    ADD COLUMN layout_id text NOT NULL DEFAULT 'full' CHECK (layout_id ~ '^[a-z][a-z0-9_]{0,39}$'),
    ADD COLUMN zones jsonb NOT NULL DEFAULT '{"main": {"type": "empty"}}'::jsonb CHECK (jsonb_typeof(zones) = 'object'),
    ADD COLUMN custom_layout_id uuid REFERENCES signage_custom_layouts(id) ON DELETE RESTRICT;
ALTER TABLE signage_scenes
    ADD CONSTRAINT signage_scenes_custom_layout_check CHECK ((layout_id = 'custom') = (custom_layout_id IS NOT NULL));
CREATE INDEX signage_scenes_custom_layout_idx ON signage_scenes (custom_layout_id) WHERE custom_layout_id IS NOT NULL;

-- +goose StatementBegin
CREATE FUNCTION signage_00129_zone_widget(blocks jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    block jsonb;
    widget jsonb;
    text_size integer;
    size text;
BEGIN
    SELECT e.value INTO block FROM jsonb_array_elements(blocks) WITH ORDINALITY AS e(value, n)
    WHERE e.value -> 'widget' ->> 'type' IS DISTINCT FROM 'empty' AND (e.value ->> 'hidden')::boolean IS NOT TRUE
    ORDER BY e.n LIMIT 1;
    IF block IS NULL THEN
        RETURN '{"type": "empty"}'::jsonb;
    END IF;
    widget := block -> 'widget';
    text_size := coalesce((block -> 'style' ->> 'textSize')::integer, 50);
    size := CASE WHEN text_size < 41 THEN 's' WHEN text_size < 63 THEN 'm' WHEN text_size < 92 THEN 'l' ELSE 'xl' END;
    CASE widget ->> 'type'
        WHEN 'text' THEN
            widget := (widget - 'fit') || jsonb_build_object('size', size, 'align', coalesce(block -> 'style' ->> 'align', 'start'));
        WHEN 'announcement' THEN
            widget := widget || jsonb_build_object('size', size);
        WHEN 'camera' THEN
            widget := widget - 'showLive' - 'showName';
        WHEN 'image' THEN
            widget := widget - 'dim';
        ELSE
            NULL;
    END CASE;
    RETURN widget;
END
$$;
-- +goose StatementEnd

UPDATE signage_scenes SET zones = jsonb_build_object('main', signage_00129_zone_widget(blocks)), version = version + 1;
DROP FUNCTION signage_00129_zone_widget(jsonb);
ALTER TABLE signage_scenes ALTER COLUMN layout_id DROP DEFAULT, ALTER COLUMN zones DROP DEFAULT;
ALTER TABLE signage_scenes DROP COLUMN blocks;
