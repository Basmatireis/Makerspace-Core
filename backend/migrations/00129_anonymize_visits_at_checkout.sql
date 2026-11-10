-- +goose Up
-- A visit keeps its person only while the person is in the lab. Check-out rolls it into the daily statistics and
-- deletes it in the same transaction; what remains per person is the UTC date of the last completed visit.
ALTER TABLE people ADD COLUMN last_visit_on date;
UPDATE people p SET last_visit_on = latest.day
FROM (
    SELECT person_id, max((checked_in_at AT TIME ZONE 'UTC')::date) AS day
    FROM visits WHERE status = 'checked_out' GROUP BY person_id
) latest
WHERE p.id = latest.person_id;

-- Invitations and tablet offers keep visit_id only to tell apart the invitation and the offer of one check-out; from
-- now on it holds a random check-out reference, not the visit's ID, and points at no row. An open offer carries the
-- person itself for the few minutes it lives.
ALTER TABLE survey_invitations DROP CONSTRAINT survey_invitations_visit_id_fkey;
ALTER TABLE survey_offers DROP CONSTRAINT survey_offers_visit_id_fkey;
ALTER TABLE survey_offers ADD COLUMN person_id uuid REFERENCES people(id) ON DELETE CASCADE;
UPDATE survey_offers o SET person_id = v.person_id FROM visits v WHERE v.id = o.visit_id AND o.consumed_at IS NULL;
DELETE FROM survey_offers WHERE consumed_at IS NULL AND person_id IS NULL;
ALTER TABLE survey_offers DROP CONSTRAINT survey_offers_check;
ALTER TABLE survey_offers ADD CONSTRAINT survey_offers_open_person_check
    CHECK (consumed_at IS NOT NULL OR (visit_id IS NOT NULL AND person_id IS NOT NULL));
CREATE INDEX survey_offers_person_idx ON survey_offers (person_id) WHERE person_id IS NOT NULL;

-- Completed and voided visits are rolled into the daily statistics once (the former 90-day retention step, with no
-- cutoff) and deleted. Days are UTC dates.
WITH expired AS (
    DELETE FROM visits WHERE status IN ('checked_out', 'voided') RETURNING *
), segments AS (
    SELECT e.*,
        (day_start AT TIME ZONE 'UTC')::date AS day,
        day_start,
        GREATEST(e.checked_in_at, day_start) AS segment_start,
        LEAST(e.checked_out_at, day_start + interval '24 hours') AS segment_end
    FROM expired e
    CROSS JOIN LATERAL generate_series(
        date_trunc('day', e.checked_in_at, 'UTC'),
        date_trunc('day', e.checked_out_at, 'UTC'),
        interval '24 hours'
    ) day_start
    WHERE e.status = 'checked_out'
), base AS (
    SELECT day,
        count(*) FILTER (WHERE checked_in_at >= day_start AND checked_in_at < day_start + interval '24 hours')::bigint AS visitor_count,
        count(DISTINCT person_id) FILTER (WHERE checked_in_at >= day_start AND checked_in_at < day_start + interval '24 hours')::bigint AS daily_unique_visitors,
        COALESCE(sum(extract(epoch FROM segment_end - segment_start)), 0)::bigint AS visitor_seconds,
        count(*) FILTER (WHERE checked_out_at >= day_start AND checked_out_at < day_start + interval '24 hours')::bigint AS completed_visit_count,
        COALESCE(sum(extract(epoch FROM checked_out_at - checked_in_at)) FILTER (WHERE checked_out_at >= day_start AND checked_out_at < day_start + interval '24 hours'), 0)::bigint AS completed_visit_seconds
    FROM segments GROUP BY day
), points AS (
    SELECT day, segment_start AS at, 1::bigint AS delta FROM segments WHERE segment_end > segment_start
    UNION ALL
    SELECT day, segment_end AS at, -1::bigint AS delta FROM segments WHERE segment_end > segment_start
), point_totals AS (
    SELECT day, at, sum(delta)::bigint AS delta FROM points GROUP BY day, at
), occupancy AS (
    SELECT day, sum(delta) OVER (PARTITION BY day ORDER BY at) AS value FROM point_totals
), aggregated AS (
    SELECT b.*, COALESCE(max(o.value), 0)::bigint AS peak_occupancy
    FROM base b LEFT JOIN occupancy o ON o.day = b.day
    GROUP BY b.day, b.visitor_count, b.daily_unique_visitors, b.visitor_seconds,
        b.completed_visit_count, b.completed_visit_seconds
)
INSERT INTO attendance_daily_statistics (day, visitor_count, daily_unique_visitors, visitor_seconds,
    completed_visit_count, completed_visit_seconds, peak_occupancy)
SELECT day, visitor_count, daily_unique_visitors, visitor_seconds,
    completed_visit_count, completed_visit_seconds, peak_occupancy
FROM aggregated
ON CONFLICT (day) DO UPDATE SET
    visitor_count = attendance_daily_statistics.visitor_count + EXCLUDED.visitor_count,
    daily_unique_visitors = attendance_daily_statistics.daily_unique_visitors + EXCLUDED.daily_unique_visitors,
    visitor_seconds = attendance_daily_statistics.visitor_seconds + EXCLUDED.visitor_seconds,
    completed_visit_count = attendance_daily_statistics.completed_visit_count + EXCLUDED.completed_visit_count,
    completed_visit_seconds = attendance_daily_statistics.completed_visit_seconds + EXCLUDED.completed_visit_seconds,
    peak_occupancy = GREATEST(attendance_daily_statistics.peak_occupancy, EXCLUDED.peak_occupancy),
    updated_at = now();

-- Ordinary check-ins and check-outs are no longer audited; corrections by the team keep their event without the
-- visit's ID.
DELETE FROM audit_events
WHERE action IN ('visit.checked_in', 'visit.checked_out', 'visit.public_checkout', 'visit.supervised_check_in');
UPDATE audit_events SET resource_id = NULL
WHERE action IN ('visit.voided', 'visit.supervised_check_out') AND resource_id IS NOT NULL;
-- An e-mail requested at the tablet named the visit, which survey_invitations.visit_id still ties to the person.
UPDATE audit_events SET resource_id = NULL
WHERE action = 'survey_offer.email_requested' AND resource_type = 'visit' AND resource_id IS NOT NULL;

-- +goose Down
-- Deleted visits and audit events cannot come back; only the schema is restored.
DROP INDEX survey_offers_person_idx;
ALTER TABLE survey_offers DROP CONSTRAINT survey_offers_open_person_check;
DELETE FROM survey_offers WHERE consumed_at IS NULL AND visit_id NOT IN (SELECT id FROM visits);
UPDATE survey_offers SET visit_id = NULL WHERE visit_id NOT IN (SELECT id FROM visits);
ALTER TABLE survey_offers ADD CONSTRAINT survey_offers_check CHECK (consumed_at IS NOT NULL OR visit_id IS NOT NULL);
ALTER TABLE survey_offers DROP COLUMN person_id;
ALTER TABLE survey_offers ADD CONSTRAINT survey_offers_visit_id_fkey
    FOREIGN KEY (visit_id) REFERENCES visits(id) ON DELETE CASCADE;
UPDATE survey_invitations SET visit_id = NULL WHERE visit_id NOT IN (SELECT id FROM visits);
ALTER TABLE survey_invitations ADD CONSTRAINT survey_invitations_visit_id_fkey
    FOREIGN KEY (visit_id) REFERENCES visits(id) ON DELETE CASCADE;
ALTER TABLE people DROP COLUMN last_visit_on;
