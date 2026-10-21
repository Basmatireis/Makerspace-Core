-- +goose Up
-- Installation-wide settings for the mail that hands an approved invoice request to the university accounting
-- office (wiRef). One row, edited with optimistic concurrency like the other settings.
CREATE TABLE wiref_delivery_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    enabled boolean NOT NULL DEFAULT false,
    recipient_email text NOT NULL DEFAULT '' CHECK (length(recipient_email) <= 254),
    cc_emails text[] NOT NULL DEFAULT '{}' CHECK (cardinality(cc_emails) <= 5),
    mail_subject text NOT NULL CHECK (length(mail_subject) BETWEEN 1 AND 200),
    mail_intro text NOT NULL CHECK (length(mail_intro) <= 2000),
    mail_closing text NOT NULL CHECK (length(mail_closing) <= 2000),
    pdf_title text NOT NULL CHECK (length(pdf_title) BETWEEN 1 AND 200),
    pdf_intro text NOT NULL CHECK (length(pdf_intro) <= 2000),
    pdf_closing text NOT NULL CHECK (length(pdf_closing) <= 2000),
    show_contact_person boolean NOT NULL DEFAULT true,
    show_approver boolean NOT NULL DEFAULT true,
    show_purchase_order boolean NOT NULL DEFAULT true,
    show_service_period boolean NOT NULL DEFAULT true,
    show_service_description boolean NOT NULL DEFAULT true,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO wiref_delivery_settings (
    singleton, mail_subject, mail_intro, mail_closing, pdf_title, pdf_intro, pdf_closing
) VALUES (
    true,
    'Invoice request {{anforderungsnummer}} for {{organisation}}',
    'An invoice request from {{organisation}} was approved on {{datum}}. Please issue the invoice described below. The same information is attached as a PDF.',
    'Please reply to this message if anything is unclear. This message was sent automatically.',
    'Invoice request {{anforderungsnummer}}',
    'Please invoice {{organisation}} for the services listed below.',
    'Approved on {{datum}}. This document was generated automatically and carries no signature.'
);

-- Whether the approved request reached the accounting office, one row per request. It lives beside the request
-- because the request header is immutable by trigger.
CREATE TABLE external_invoice_request_deliveries (
    request_id uuid PRIMARY KEY REFERENCES external_invoice_requests(id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('not_configured', 'sent', 'failed')),
    attempted_at timestamptz NOT NULL,
    failure_code text NOT NULL DEFAULT '' CHECK (length(failure_code) <= 64)
);

-- +goose Down
DROP TABLE external_invoice_request_deliveries;
DROP TABLE wiref_delivery_settings;
