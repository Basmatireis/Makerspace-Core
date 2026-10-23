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
