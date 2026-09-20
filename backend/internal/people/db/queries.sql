-- name: CreatePerson :one
INSERT INTO people (id, first_name, last_name, email, phone, matriculation_number, photo_reference)
VALUES (sqlc.arg(id), sqlc.arg(first_name), sqlc.arg(last_name), sqlc.narg(email), sqlc.narg(phone), sqlc.narg(matriculation_number), sqlc.narg(photo_reference))
RETURNING *;

-- name: GetPerson :one
SELECT * FROM people WHERE id = sqlc.arg(id);

-- name: GetPersonForDeletion :one
SELECT * FROM people WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: ListPeople :many
SELECT * FROM people
WHERE sqlc.arg(search)::text = ''
   OR first_name ILIKE '%' || sqlc.arg(search)::text || '%'
   OR last_name ILIKE '%' || sqlc.arg(search)::text || '%'
   OR COALESCE(email, '') ILIKE '%' || sqlc.arg(search)::text || '%'
   OR COALESCE(phone, '') ILIKE '%' || sqlc.arg(search)::text || '%'
   OR (sqlc.arg(include_matriculation)::boolean AND COALESCE(matriculation_number, '') ILIKE '%' || sqlc.arg(search)::text || '%')
ORDER BY lower(last_name), lower(first_name), id
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountPeople :one
SELECT count(*) FROM people
WHERE sqlc.arg(search)::text = ''
   OR first_name ILIKE '%' || sqlc.arg(search)::text || '%'
   OR last_name ILIKE '%' || sqlc.arg(search)::text || '%'
   OR COALESCE(email, '') ILIKE '%' || sqlc.arg(search)::text || '%'
   OR COALESCE(phone, '') ILIKE '%' || sqlc.arg(search)::text || '%'
   OR (sqlc.arg(include_matriculation)::boolean AND COALESCE(matriculation_number, '') ILIKE '%' || sqlc.arg(search)::text || '%');

-- name: UpdatePerson :one
UPDATE people
SET first_name = sqlc.arg(first_name), last_name = sqlc.arg(last_name),
    email = sqlc.narg(email), phone = sqlc.narg(phone),
    matriculation_number = sqlc.narg(matriculation_number), photo_reference = sqlc.narg(photo_reference),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: DeletePerson :one
DELETE FROM people WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING id;

-- name: SetProfileImage :one
UPDATE people
SET profile_image_file_id = sqlc.narg(profile_image_file_id),
    profile_image_source = sqlc.narg(profile_image_source),
    version = version + 1,
    updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: GetProfileImage :one
SELECT profile_image_file_id, profile_image_source
FROM people
WHERE id = sqlc.arg(id);

-- name: PersonRequiresProfileImage :one
SELECT COALESCE(bool_or(r.profile_image_required), false)::boolean
FROM accounts a
LEFT JOIN account_roles ar ON ar.account_id = a.id
LEFT JOIN roles r ON r.id = ar.role_id
WHERE a.person_id = sqlc.arg(person_id);
