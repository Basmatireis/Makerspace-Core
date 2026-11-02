-- +goose Up
-- Digital signage: displays and scenes carry a reduced aspect ratio instead of orientation and pixel resolution.

ALTER TABLE signage_displays
    ADD COLUMN aspect_width smallint,
    ADD COLUMN aspect_height smallint;
-- Reduce the resolution by its greatest common divisor; a ratio that stays above 100 falls back to
-- 16:9 or 9:16 by its orientation.
UPDATE signage_displays d
SET aspect_width = CASE WHEN r.w <= 100 AND r.h <= 100 THEN r.w WHEN d.orientation = 'landscape' THEN 16 ELSE 9 END,
    aspect_height = CASE WHEN r.w <= 100 AND r.h <= 100 THEN r.h WHEN d.orientation = 'landscape' THEN 9 ELSE 16 END
FROM (
    SELECT id,
           resolution_width / gcd(resolution_width, resolution_height) AS w,
           resolution_height / gcd(resolution_width, resolution_height) AS h
    FROM signage_displays
) r
WHERE r.id = d.id;
ALTER TABLE signage_displays
    ALTER COLUMN aspect_width SET NOT NULL,
    ALTER COLUMN aspect_height SET NOT NULL,
    ADD CONSTRAINT signage_displays_aspect_width_check CHECK (aspect_width BETWEEN 1 AND 100),
    ADD CONSTRAINT signage_displays_aspect_height_check CHECK (aspect_height BETWEEN 1 AND 100),
    DROP COLUMN orientation,
    DROP COLUMN resolution_width,
    DROP COLUMN resolution_height;

ALTER TABLE signage_scenes
    ADD COLUMN aspect_width smallint,
    ADD COLUMN aspect_height smallint;
UPDATE signage_scenes
SET aspect_width = CASE WHEN orientation = 'portrait' THEN 9 ELSE 16 END,
    aspect_height = CASE WHEN orientation = 'portrait' THEN 16 ELSE 9 END;
ALTER TABLE signage_scenes
    ALTER COLUMN aspect_width SET NOT NULL,
    ALTER COLUMN aspect_height SET NOT NULL,
    ADD CONSTRAINT signage_scenes_aspect_width_check CHECK (aspect_width BETWEEN 1 AND 100),
    ADD CONSTRAINT signage_scenes_aspect_height_check CHECK (aspect_height BETWEEN 1 AND 100),
    DROP COLUMN orientation;

-- +goose Down
ALTER TABLE signage_scenes ADD COLUMN orientation text;
UPDATE signage_scenes SET orientation = CASE WHEN aspect_width >= aspect_height THEN 'landscape' ELSE 'portrait' END;
ALTER TABLE signage_scenes
    ALTER COLUMN orientation SET NOT NULL,
    ADD CONSTRAINT signage_scenes_orientation_check CHECK (orientation IN ('portrait', 'landscape')),
    DROP COLUMN aspect_width,
    DROP COLUMN aspect_height;

ALTER TABLE signage_displays
    ADD COLUMN orientation text,
    ADD COLUMN resolution_width integer,
    ADD COLUMN resolution_height integer;
UPDATE signage_displays
SET orientation = CASE WHEN aspect_width >= aspect_height THEN 'landscape' ELSE 'portrait' END,
    resolution_width = CASE WHEN aspect_width >= aspect_height THEN 1920 ELSE 1080 END,
    resolution_height = CASE WHEN aspect_width >= aspect_height THEN 1080 ELSE 1920 END;
ALTER TABLE signage_displays
    ALTER COLUMN orientation SET NOT NULL,
    ALTER COLUMN resolution_width SET NOT NULL,
    ALTER COLUMN resolution_height SET NOT NULL,
    ADD CONSTRAINT signage_displays_orientation_check CHECK (orientation IN ('portrait', 'landscape')),
    ADD CONSTRAINT signage_displays_resolution_width_check CHECK (resolution_width BETWEEN 320 AND 16384),
    ADD CONSTRAINT signage_displays_resolution_height_check CHECK (resolution_height BETWEEN 320 AND 16384),
    DROP COLUMN aspect_width,
    DROP COLUMN aspect_height;
