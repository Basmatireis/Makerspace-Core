-- +goose Up
-- The wiRef template placeholders get English names like the rest of the application. Stored templates are rewritten
-- token by token, so they keep working; the old German names are not accepted afterwards. The version moves on, so an
-- editor that still shows the old text gets 409 stale_write instead of 422 for a placeholder it did not type.
-- +goose StatementBegin
DO $$
DECLARE
    pair text[];
BEGIN
    FOREACH pair SLICE 1 IN ARRAY ARRAY[
        ['organisation', 'organization'],
        ['kontaktperson', 'contact_person'],
        ['bestellreferenz', 'purchase_order_reference'],
        ['anforderungsnummer', 'request_number'],
        ['auftragsnummer', 'order_number'],
        ['summe', 'amount_to_invoice'],
        ['freigegeben_von', 'approved_by'],
        ['datum', 'approved_on']
    ] LOOP
        UPDATE wiref_delivery_settings SET
            mail_subject = replace(mail_subject, '{{' || pair[1] || '}}', '{{' || pair[2] || '}}'),
            mail_intro = replace(mail_intro, '{{' || pair[1] || '}}', '{{' || pair[2] || '}}'),
            mail_closing = replace(mail_closing, '{{' || pair[1] || '}}', '{{' || pair[2] || '}}'),
            pdf_title = replace(pdf_title, '{{' || pair[1] || '}}', '{{' || pair[2] || '}}'),
            pdf_intro = replace(pdf_intro, '{{' || pair[1] || '}}', '{{' || pair[2] || '}}'),
            pdf_closing = replace(pdf_closing, '{{' || pair[1] || '}}', '{{' || pair[2] || '}}');
    END LOOP;
    UPDATE wiref_delivery_settings SET version = version + 1;
END
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DO $$
DECLARE
    pair text[];
BEGIN
    FOREACH pair SLICE 1 IN ARRAY ARRAY[
        ['organization', 'organisation'],
        ['contact_person', 'kontaktperson'],
        ['purchase_order_reference', 'bestellreferenz'],
        ['request_number', 'anforderungsnummer'],
        ['order_number', 'auftragsnummer'],
        ['amount_to_invoice', 'summe'],
        ['approved_by', 'freigegeben_von'],
        ['approved_on', 'datum']
    ] LOOP
        UPDATE wiref_delivery_settings SET
            mail_subject = replace(mail_subject, '{{' || pair[1] || '}}', '{{' || pair[2] || '}}'),
            mail_intro = replace(mail_intro, '{{' || pair[1] || '}}', '{{' || pair[2] || '}}'),
            mail_closing = replace(mail_closing, '{{' || pair[1] || '}}', '{{' || pair[2] || '}}'),
            pdf_title = replace(pdf_title, '{{' || pair[1] || '}}', '{{' || pair[2] || '}}'),
            pdf_intro = replace(pdf_intro, '{{' || pair[1] || '}}', '{{' || pair[2] || '}}'),
            pdf_closing = replace(pdf_closing, '{{' || pair[1] || '}}', '{{' || pair[2] || '}}');
    END LOOP;
    UPDATE wiref_delivery_settings SET version = version + 1;
END
$$;
-- +goose StatementEnd
