-- name: ListCompetencyCategories :many
SELECT c.*, (SELECT count(*) FROM training_competencies tc WHERE tc.competency_id = c.id)::bigint AS training_count
FROM competency_categories c
ORDER BY c.active DESC, c.sort_order, lower(c.name), c.id;

-- name: GetCompetencyCategory :one
SELECT c.*, (SELECT count(*) FROM training_competencies tc WHERE tc.competency_id = c.id)::bigint AS training_count
FROM competency_categories c WHERE c.id = sqlc.arg(id);

-- name: GetCompetencyCategoryForUpdate :one
SELECT * FROM competency_categories WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: CreateCompetencyCategory :exec
INSERT INTO competency_categories (id, name, description, active, sort_order)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.narg(description), sqlc.arg(active), sqlc.arg(sort_order));

-- name: UpdateCompetencyCategory :execrows
UPDATE competency_categories
SET name = sqlc.arg(name), description = sqlc.narg(description), active = sqlc.arg(active),
    sort_order = sqlc.arg(sort_order), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version);

-- name: DeleteCompetencyCategory :execrows
DELETE FROM competency_categories WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version);

-- name: CountExistingCompetencyCategories :one
SELECT count(*) FROM competency_categories WHERE id = ANY(sqlc.arg(ids)::uuid[]);

-- name: ListTrainings :many
SELECT t.*, (SELECT count(*) FROM training_records r WHERE r.training_id = t.id)::bigint AS record_count
FROM trainings t
ORDER BY t.active DESC, t.sort_order, lower(t.name), t.id;

-- name: GetTraining :one
SELECT t.*, (SELECT count(*) FROM training_records r WHERE r.training_id = t.id)::bigint AS record_count
FROM trainings t WHERE t.id = sqlc.arg(id);

-- name: GetTrainingForUpdate :one
SELECT * FROM trainings WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: CreateTraining :exec
INSERT INTO trainings (id, name, description, active, sort_order)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.narg(description), sqlc.arg(active), sqlc.arg(sort_order));

-- name: UpdateTraining :execrows
UPDATE trainings
SET name = sqlc.arg(name), description = sqlc.narg(description), active = sqlc.arg(active),
    sort_order = sqlc.arg(sort_order), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version);

-- name: DeleteTraining :execrows
DELETE FROM trainings WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version);

-- name: ListTrainingCompetencies :many
SELECT training_id, competency_id FROM training_competencies
WHERE training_id = ANY(sqlc.arg(training_ids)::uuid[])
ORDER BY training_id, competency_id;

-- name: DeleteTrainingCompetencies :exec
DELETE FROM training_competencies WHERE training_id = sqlc.arg(training_id);

-- name: InsertTrainingCompetency :exec
INSERT INTO training_competencies (training_id, competency_id) VALUES (sqlc.arg(training_id), sqlc.arg(competency_id));

-- name: ListTrainingMachineTypes :many
SELECT training_id, machine_type_id FROM training_machine_types
WHERE training_id = ANY(sqlc.arg(training_ids)::uuid[])
ORDER BY training_id, machine_type_id;

-- name: DeleteTrainingMachineTypes :exec
DELETE FROM training_machine_types WHERE training_id = sqlc.arg(training_id);

-- name: InsertTrainingMachineType :exec
INSERT INTO training_machine_types (training_id, machine_type_id) VALUES (sqlc.arg(training_id), sqlc.arg(machine_type_id));

-- name: CountExistingMachineTypes :one
SELECT count(*) FROM machine_types WHERE id = ANY(sqlc.arg(ids)::uuid[]);

-- name: PersonExists :one
SELECT EXISTS (SELECT 1 FROM people WHERE id = sqlc.arg(id))::boolean;

-- name: LockPersonForShare :one
SELECT id FROM people WHERE id = sqlc.arg(id) FOR SHARE;

-- name: ListPersonTrainingRecords :many
-- Every active training plus inactive ones the person holds a record of; no record means not trained.
SELECT t.id AS training_id, t.name AS training_name, t.active AS training_active,
       r.status, r.completed_on, r.notes, r.version, r.updated_at
FROM trainings t
LEFT JOIN training_records r ON r.training_id = t.id AND r.person_id = sqlc.arg(person_id)
WHERE t.active OR r.person_id IS NOT NULL
ORDER BY t.active DESC, t.sort_order, lower(t.name), t.id;

-- name: GetTrainingRecordForUpdate :one
SELECT * FROM training_records
WHERE person_id = sqlc.arg(person_id) AND training_id = sqlc.arg(training_id)
FOR UPDATE;

-- name: GetTrainingForShare :one
SELECT * FROM trainings WHERE id = sqlc.arg(id) FOR SHARE;

-- name: InsertTrainingRecord :exec
INSERT INTO training_records (person_id, training_id, status, completed_on, notes, recorded_by_account_id)
VALUES (sqlc.arg(person_id), sqlc.arg(training_id), sqlc.arg(status), sqlc.narg(completed_on), sqlc.narg(notes),
        sqlc.narg(recorded_by_account_id));

-- name: UpdateTrainingRecord :execrows
UPDATE training_records
SET status = sqlc.arg(status), completed_on = sqlc.narg(completed_on), notes = sqlc.narg(notes),
    recorded_by_account_id = sqlc.narg(recorded_by_account_id), version = version + 1, updated_at = now()
WHERE person_id = sqlc.arg(person_id) AND training_id = sqlc.arg(training_id) AND version = sqlc.arg(expected_version);

-- name: DeleteTrainingRecord :execrows
DELETE FROM training_records
WHERE person_id = sqlc.arg(person_id) AND training_id = sqlc.arg(training_id) AND version = sqlc.arg(expected_version);

-- name: ListOpenDayCompetencies :many
-- The active competency categories the supervisors assigned to scheduled open days are trained for. Trainee places,
-- inactive trainings and inactive categories do not count; trained and trainer count alike. IDs are passed as text so
-- the query also runs in pgx's simple protocol mode.
SELECT DISTINCT a.open_day_id, c.id, c.name, c.sort_order, lower(c.name) AS sort_name
FROM open_day_assignments a
JOIN open_days d ON d.id = a.open_day_id AND d.status = 'scheduled'
JOIN open_day_staff_requirements r ON r.id = a.requirement_id AND r.kind = 'supervisor'
JOIN training_records tr ON tr.person_id = a.person_id
JOIN trainings t ON t.id = tr.training_id AND t.active
JOIN training_competencies tc ON tc.training_id = t.id
JOIN competency_categories c ON c.id = tc.competency_id AND c.active
WHERE a.open_day_id = ANY(sqlc.arg(open_day_ids)::text[]::uuid[])
ORDER BY a.open_day_id, c.sort_order, sort_name, c.id;
