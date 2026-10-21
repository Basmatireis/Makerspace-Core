-- name: GetSettings :one
SELECT * FROM wiref_delivery_settings WHERE singleton=true;

-- name: GetSettingsForUpdate :one
SELECT * FROM wiref_delivery_settings WHERE singleton=true FOR UPDATE;

-- name: UpdateSettings :one
UPDATE wiref_delivery_settings SET
  enabled=sqlc.arg(enabled), recipient_email=sqlc.arg(recipient_email), cc_emails=sqlc.arg(cc_emails)::text[],
  mail_subject=sqlc.arg(mail_subject), mail_intro=sqlc.arg(mail_intro), mail_closing=sqlc.arg(mail_closing),
  pdf_title=sqlc.arg(pdf_title), pdf_intro=sqlc.arg(pdf_intro), pdf_closing=sqlc.arg(pdf_closing),
  show_contact_person=sqlc.arg(show_contact_person), show_approver=sqlc.arg(show_approver),
  show_purchase_order=sqlc.arg(show_purchase_order), show_service_period=sqlc.arg(show_service_period),
  show_service_description=sqlc.arg(show_service_description),
  version=version+1, updated_by_account_id=sqlc.arg(updated_by_account_id), updated_at=now()
WHERE singleton=true AND version=sqlc.arg(expected_version)
RETURNING *;
