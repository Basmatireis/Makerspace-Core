-- name: GetOwnDashboardPerson :one
SELECT first_name, member_since FROM people WHERE id = sqlc.arg(id);
