package integration_test

import (
	"sort"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/staginganonymizer"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const stagingCanary = "Zebracanary"

// seedStagingPersonalData fills personal text in as many places as the schema allows. Every personal value
// contains stagingCanary, so a single schema-wide search finds whatever the anonymizer leaves behind.
func seedStagingPersonalData(t *testing.T, pool *pgxpool.Pool) (master, plain, oidcMaster seededAccount, profileFile uuid.UUID) {
	t.Helper()
	exec := func(query string, args ...any) { mergeExec(t, pool, query, args...) }

	master = seedAccount(t, pool, "zebracanary.master", true)
	plain = seedAccount(t, pool, "zebracanary.plain", false)
	oidcMaster = seedAccount(t, pool, "zebracanary.oidc", true)

	for i, a := range []seededAccount{master, plain, oidcMaster} {
		exec(`UPDATE people SET first_name = $2, last_name = $3, phone = $4, matriculation_number = $5 WHERE id = $1`,
			a.personID, stagingCanary+"First", stagingCanary+"Last", "+43 660 zebracanary", "zebracanary0123456"+string(rune('0'+i)))
	}

	// Credentials, sessions and second factors.
	exec(`INSERT INTO sessions (id, account_id, auth_identity_id, token_digest, csrf_digest, auth_method,
			idle_expires_at, absolute_expires_at)
		SELECT $1, account_id, id, decode(repeat('01', 32), 'hex'), decode(repeat('02', 32), 'hex'), 'password',
			now() + interval '1 hour', now() + interval '2 hours'
		FROM auth_identities WHERE account_id = $2 AND kind = 'password'`, ids.New(), plain.accountID)
	exec(`INSERT INTO mfa_totp_credentials (id, account_id, secret_ciphertext, confirmed_at)
		VALUES ($1, $2, '\x0a0b0c', now())`, ids.New(), plain.accountID)
	exec(`INSERT INTO mfa_recovery_codes (id, account_id, code_digest) VALUES ($1, $2, decode(repeat('0d', 32), 'hex'))`,
		ids.New(), plain.accountID)
	pinIdentity := ids.New()
	exec(`INSERT INTO auth_identities (id, account_id, kind, identifier_display, identifier_normalized, verified_at)
		VALUES ($1, $2, 'pin', 'Zebracanary.Pin', 'zebracanary.pin', now())`, pinIdentity, plain.accountID)
	exec(`INSERT INTO pin_credentials (auth_identity_id, pin_hash) VALUES ($1, 'zebracanary-pin-hash')`, pinIdentity)
	exec(`INSERT INTO calendar_feeds (person_id, token_digest, created_at) VALUES ($1, decode(repeat('ab', 32), 'hex'), now())`,
		plain.personID)

	// The OIDC-only master: no password identity, so the anonymizer must create one.
	provider := ids.New()
	exec(`INSERT INTO oidc_providers (id, slug, display_name, issuer, client_id, encrypted_client_secret)
		VALUES ($1, 'zebracanary-sso', 'Zebracanary SSO', 'https://sso.zebracanary.example', 'zebracanary-client', '\x01')`,
		provider)
	exec(`DELETE FROM auth_identities WHERE account_id = $1 AND kind = 'password'`, oidcMaster.accountID)
	exec(`INSERT INTO auth_identities (id, account_id, kind, provider_id, issuer, subject, verified_at)
		VALUES ($1, $2, 'oidc', $3, 'https://sso.zebracanary.example', 'zebracanary-subject', now())`,
		ids.New(), oidcMaster.accountID, provider)

	// Profile image of a person.
	profileFile = ids.New()
	exec(`INSERT INTO files (id, storage_key, original_filename, content_type, size_bytes, sha256)
		VALUES ($1, $2, 'zebracanary_portrait.jpg', 'image/jpeg', 10, decode(repeat('cd', 32), 'hex'))`,
		profileFile, "blobs/"+profileFile.String())
	exec(`UPDATE people SET profile_image_file_id = $1, profile_image_source = 'self_upload' WHERE id = $2`,
		profileFile, plain.personID)

	// Audit, notifications, privacy requests.
	exec(`INSERT INTO audit_events (id, actor_account_id, action, resource_type, resource_id, metadata)
		VALUES ($1, $2, 'person.update', 'person', $3, '{"name": "Zebracanary Last"}')`,
		ids.New(), master.accountID, plain.personID)
	exec(`INSERT INTO inbox_notifications (id, kind, title, body, expires_at)
		VALUES ($1, 'message', 'Zebracanary title', 'Dear Zebracanary', now() + interval '1 day')`, ids.New())
	exec(`INSERT INTO privacy_subject_requests (id, kind, status, subject_person_id, reference, channel,
			received_at, due_at, notes)
		VALUES ($1, 'access', 'received', $2, 'zebracanary-ref', 'email', now(), now() + interval '30 days',
			'Zebracanary asked by phone')`, ids.New(), plain.personID)

	// Event shift sign-up by an external person.
	eventID, shiftID, requirementID := ids.New(), ids.New(), ids.New()
	exec(`INSERT INTO events (id, name, internal_description, public_id, status)
		VALUES ($1, 'Open workshop', 'Zebracanary internal note', $2, 'confirmed')`,
		eventID, strings.Repeat("e", 43))
	exec(`INSERT INTO event_shifts (id, event_id, name, starts_at, ends_at, status)
		VALUES ($1, $2, 'Door', now() + interval '1 day', now() + interval '2 days', 'open')`, shiftID, eventID)
	exec(`INSERT INTO event_shift_requirements (id, event_id, shift_id, name, required_count)
		VALUES ($1, $2, $3, 'Host', 2)`, requirementID, eventID, shiftID)
	exec(`INSERT INTO event_shift_assignments (id, event_id, shift_id, requirement_id, first_name_snapshot,
			last_name_snapshot, email_snapshot, email_normalized, phone_snapshot, phone_normalized, source, status,
			management_token_digest)
		VALUES ($1, $2, $3, $4, 'Zebracanary', 'Guest', 'zebracanary.guest@real.example',
			'zebracanary.guest@real.example', '+43 1 zebracanary', '+431zebracanary', 'public_signup', 'active',
			decode(repeat('ef', 32), 'hex'))`, ids.New(), eventID, shiftID, requirementID)

	// Survey with a free-text answer.
	surveyID, versionID, questionID, responseID := ids.New(), ids.New(), ids.New(), ids.New()
	exec(`INSERT INTO surveys (id, name, anonymous) VALUES ($1, 'Feedback', false)`, surveyID)
	exec(`INSERT INTO survey_versions (id, survey_id, revision, title) VALUES ($1, $2, 1, 'Feedback')`,
		versionID, surveyID)
	exec(`INSERT INTO survey_questions (id, survey_version_id, kind, prompt, position)
		VALUES ($1, $2, 'free_text', 'Anything else?', 1)`, questionID, versionID)
	exec(`INSERT INTO survey_responses (id, survey_version_id, submitted_on, identified_person_id)
		VALUES ($1, $2, current_date, $3)`, responseID, versionID, plain.personID)
	exec(`INSERT INTO survey_answers (id, response_id, question_id, text_value, position)
		VALUES ($1, $2, $3, 'Zebracanary wrote this', 1)`, ids.New(), responseID, questionID)

	// Machine, job, run.
	processID, machineID, jobID := ids.New(), ids.New(), ids.New()
	exec(`INSERT INTO processes (id, name, integration) VALUES ($1, 'FDM printing', 'fdm_printer')`, processID)
	exec(`INSERT INTO machines (id, process_id, name) VALUES ($1, $2, 'Printer one')`, machineID, processID)
	exec(`INSERT INTO machine_jobs (id, display_id, machine_id, customer_person_id, title, notes)
		VALUES ($1, 'J-2030-900001', $2, $3, 'Zebracanary bracket', 'Zebracanary wants it blue')`,
		jobID, machineID, plain.personID)
	exec(`INSERT INTO machine_runs (id, display_id, machine_id, source, job_id, started_at, ended_at,
			history_complete, file_name)
		VALUES ($1, 'R-2030-900001', $2, 'manual', $3, now() - interval '2 hours', now() - interval '1 hour', true,
			'canary_secret_part.gcode.3mf')`, ids.New(), machineID, jobID)
	exec(`UPDATE machine_runs SET file_name = 'Zebracanary_secret_part.gcode.3mf' WHERE job_id = $1`, jobID)

	// Inventory note on a spool and on its material.
	typeID, materialID := ids.New(), ids.New()
	exec(`INSERT INTO material_types (id, name, unit, kind, code, machine_use)
		VALUES ($1, 'PLA', 'g', 'filament', 'PLA', true)`, typeID)
	exec(`INSERT INTO materials (id, name, unit, material_type_id, display_id, notes)
		VALUES ($1, 'PLA red', 'g', $2, 'A-0001', 'Zebracanary bought it')`, materialID, typeID)
	exec(`INSERT INTO filament_spools (id, display_id, material_id, initial_net_weight_g, notes, acquisition_reference)
		VALUES ($1, 'S-2030-000001', $2, 1000, 'Zebracanary private spool', 'Zebracanary receipt')`,
		ids.New(), materialID)

	// Organization contact, mail, wiRef.
	exec(`INSERT INTO organizations (id, name, kind, address_line, contact_name, contact_email)
		VALUES ($1, 'Club', 'other', 'Zebracanary Street 1', 'Zebracanary Contact', 'zebracanary.org@real.example')`,
		ids.New())
	exec(`UPDATE mail_configuration SET enabled = true, provider = 'smtp', smtp_host = 'smtp.zebracanary.example',
			smtp_port = 587, smtp_tls_mode = 'starttls', smtp_username = 'zebracanary-user',
			encrypted_smtp_password = '\x01020304', from_address = 'zebracanary@real.example',
			base_url = 'https://zebracanary.real.example'`)
	exec(`UPDATE wiref_delivery_settings SET enabled = true, recipient_email = 'zebracanary.wiref@real.example',
			reply_to_email = 'zebracanary.reply@real.example', cc_emails = ARRAY['zebracanary.cc@real.example']`)

	// Training note and visit correction.
	trainingID := ids.New()
	exec(`INSERT INTO trainings (id, name) VALUES ($1, 'Laser cutter')`, trainingID)
	exec(`INSERT INTO training_records (person_id, training_id, status, notes)
		VALUES ($1, $2, 'trained', 'Zebracanary passed')`, plain.personID, trainingID)
	exec(`INSERT INTO visits (id, person_id, checked_in_at, checked_out_at, status, check_in_method,
			check_out_method, check_in_assurance, admission_decision, correction_reason)
		VALUES ($1, $2, now() - interval '3 hours', now() - interval '2 hours', 'checked_out', 'supervisor',
			'supervisor', 'normal', 'admitted', 'Zebracanary forgot to check out')`, ids.New(), plain.personID)
	return master, plain, oidcMaster, profileFile
}

func TestStagingAnonymizerLeavesNoPersonalData(t *testing.T) {
	// The production pool uses pgx's default query mode; the simple protocol cannot encode empty UUID slices.
	pool := migratedPoolMode(t, pgx.QueryExecModeCacheStatement)
	ctx := testContext(t)
	master, plain, oidcMaster, profileFile := seedStagingPersonalData(t, pool)

	// Sanity: the canary is really present before the run.
	if n := stagingCanaryCells(t, pool); len(n) < 20 {
		t.Fatalf("seed contains the canary in only %d columns: %v", len(n), n)
	}

	result, err := staginganonymizer.NewService(pool).Anonymize(ctx, "http://localhost:8080")
	if err != nil {
		t.Fatalf("anonymize: %v", err)
	}

	if leaks := stagingCanaryCells(t, pool); len(leaks) > 0 {
		t.Errorf("canary survives in %d columns:\n  %s", len(leaks), strings.Join(leaks, "\n  "))
	}

	for _, table := range []string{
		"sessions", "password_credentials", "pin_credentials", "mfa_totp_credentials", "mfa_recovery_codes",
		"webauthn_credentials", "calendar_feeds", "inbox_notifications", "privacy_subject_requests",
		"oidc_providers",
	} {
		assertCount(t, pool, "SELECT count(*) FROM "+pgx.Identifier{table}.Sanitize(), 0)
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events`, 1)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action = 'system.anonymized_for_staging'`, 1)
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE kind <> 'password'`, 0)

	assertCount(t, pool, `SELECT count(*) FROM people WHERE email IS NULL OR email NOT LIKE '%@example.invalid'`, 0)
	assertCount(t, pool, `SELECT count(*) FROM people WHERE phone IS NOT NULL OR matriculation_number IS NOT NULL`, 0)
	assertCount(t, pool, `SELECT count(*) FROM people WHERE profile_image_file_id IS NOT NULL`, 0)
	assertCount(t, pool, `SELECT count(*) FROM files WHERE id = $1`, 0, profileFile)
	assertCount(t, pool, `SELECT count(*) FROM auth_identities i JOIN accounts a ON a.id = i.account_id
		JOIN people p ON p.id = a.person_id
		WHERE i.kind = 'password' AND (i.identifier_display <> p.email OR i.identifier_normalized <> lower(p.email))`, 0)
	assertCount(t, pool, `SELECT count(*) FROM accounts a WHERE NOT EXISTS
		(SELECT 1 FROM auth_identities i WHERE i.account_id = a.id AND i.kind = 'password')`, 0)

	var plainEmail string
	if err := pool.QueryRow(ctx, `SELECT email FROM people WHERE id = $1`, plain.personID).Scan(&plainEmail); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToLower(plainEmail), "zebra") {
		t.Fatalf("plain email %q still derives from the original", plainEmail)
	}
	var masterEmails []string
	for _, a := range []seededAccount{master, oidcMaster} {
		var email string
		if err := pool.QueryRow(ctx, `SELECT email FROM people WHERE id = $1`, a.personID).Scan(&email); err != nil {
			t.Fatal(err)
		}
		masterEmails = append(masterEmails, email)
		assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE account_id = $1 AND kind = 'password'
			AND identifier_display = $2`, 1, a.accountID, email)
	}
	got := append([]string(nil), result.MasterLoginEmails...)
	sort.Strings(got)
	sort.Strings(masterEmails)
	if strings.Join(got, ",") != strings.Join(masterEmails, ",") {
		t.Fatalf("MasterLoginEmails = %v, want %v", got, masterEmails)
	}
	if result.DeletedFiles < 1 {
		t.Fatalf("DeletedFiles = %d, want at least the profile image", result.DeletedFiles)
	}

	var host, tls string
	var port int
	var password []byte
	if err := pool.QueryRow(ctx, `SELECT smtp_host, smtp_port, smtp_tls_mode, encrypted_smtp_password
		FROM mail_configuration`).Scan(&host, &port, &tls, &password); err != nil {
		t.Fatal(err)
	}
	if host != "mailpit" || port != 1025 || tls != "none" || password != nil {
		t.Fatalf("mail configuration = %q %d %q %v, want mailpit 1025 none NULL", host, port, tls, password)
	}

	assertCount(t, pool, `SELECT count(*) FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = current_schema() AND NOT tg.tgisinternal AND tg.tgenabled = 'D'`, 0)
}

func TestStagingAnonymizerKeepsFakeNamesStable(t *testing.T) {
	// The production pool uses pgx's default query mode; the simple protocol cannot encode empty UUID slices.
	pool := migratedPoolMode(t, pgx.QueryExecModeCacheStatement)
	ctx := testContext(t)
	person := seedAccount(t, pool, "stable-name", true)
	service := staginganonymizer.NewService(pool)

	if _, err := service.Anonymize(ctx, "http://localhost:8080"); err != nil {
		t.Fatal(err)
	}
	var first, last string
	read := func() (string, string) {
		var f, l string
		if err := pool.QueryRow(ctx, `SELECT first_name, last_name FROM people WHERE id = $1`, person.personID).
			Scan(&f, &l); err != nil {
			t.Fatal(err)
		}
		return f, l
	}
	first, last = read()
	if first == "Test" && last == "Person" {
		t.Fatalf("name was not anonymized: %s %s", first, last)
	}

	mergeExec(t, pool, `UPDATE people SET first_name = 'Someone', last_name = 'Else' WHERE id = $1`, person.personID)
	if _, err := service.Anonymize(ctx, "http://localhost:8080"); err != nil {
		t.Fatal(err)
	}
	if f, l := read(); f != first || l != last {
		t.Fatalf("fake name changed from %s %s to %s %s", first, last, f, l)
	}
}

// stagingCanaryCells lists every table.column of the current schema whose text still contains the canary.
func stagingCanaryCells(t *testing.T, pool *pgxpool.Pool) []string {
	t.Helper()
	ctx := testContext(t)
	rows, err := pool.Query(ctx, `
		SELECT c.table_name, c.column_name
		FROM information_schema.columns c
		JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
		WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
		  AND c.data_type IN ('text', 'character varying', 'jsonb', 'json', 'ARRAY')
		ORDER BY c.table_name, c.ordinal_position`)
	if err != nil {
		t.Fatal(err)
	}
	type cell struct{ table, column string }
	var cells []cell
	for rows.Next() {
		var c cell
		if err := rows.Scan(&c.table, &c.column); err != nil {
			t.Fatal(err)
		}
		cells = append(cells, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	var found []string
	for _, c := range cells {
		query := "SELECT count(*) FROM " + pgx.Identifier{c.table}.Sanitize() + " WHERE " +
			pgx.Identifier{c.column}.Sanitize() + "::text ILIKE '%" + strings.ToLower(stagingCanary) + "%'"
		var n int
		if err := pool.QueryRow(ctx, query).Scan(&n); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
		if n > 0 {
			found = append(found, c.table+"."+c.column)
		}
	}
	return found
}
