-- name: GetConfiguration :one
SELECT * FROM mail_configuration WHERE singleton=true;

-- name: GetConfigurationForUpdate :one
SELECT * FROM mail_configuration WHERE singleton=true FOR UPDATE;

-- name: UpdateConfiguration :one
UPDATE mail_configuration SET
  enabled=sqlc.arg(enabled), provider='smtp', smtp_host=sqlc.arg(smtp_host),
  smtp_port=sqlc.arg(smtp_port), smtp_tls_mode=sqlc.arg(smtp_tls_mode),
  smtp_username=sqlc.arg(smtp_username), encrypted_smtp_password=sqlc.narg(encrypted_smtp_password),
  from_address=sqlc.arg(from_address), from_name=sqlc.arg(from_name), base_url=sqlc.arg(base_url),
  version=version+1, updated_by_account_id=sqlc.arg(updated_by_account_id), updated_at=now()
WHERE singleton=true AND version=sqlc.arg(expected_version)
RETURNING *;
