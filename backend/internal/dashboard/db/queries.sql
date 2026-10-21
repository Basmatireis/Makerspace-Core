-- name: GetOwnDashboardPerson :one
SELECT first_name, created_at FROM people WHERE id = sqlc.arg(id);
