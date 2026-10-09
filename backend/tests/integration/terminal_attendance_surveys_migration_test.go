package integration_test

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	attendancedb "github.com/Basmatireis/Makerspace-Core/backend/internal/attendance/db"
	surveysdb "github.com/Basmatireis/Makerspace-Core/backend/internal/surveys/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

func TestTerminalAttendanceSurveyMigrationConstraints(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)

	assertCount(t, pool, "SELECT count(*) FROM session_policies WHERE is_default", 1)
	_, err := pool.Exec(ctx, `INSERT INTO session_policies(id,name,idle_timeout_seconds,absolute_lifetime_seconds,post_session_destination,is_default)
		VALUES($1,'Second default',60,300,'login',true)`, uuid.Must(uuid.NewV7()))
	expectPostgresCode(t, err, "23505")
	deviceTypeID := uuid.Must(uuid.NewV7())
	if _, err = pool.Exec(ctx, `INSERT INTO device_types(id,name) VALUES($1,'Constraint terminal')`, deviceTypeID); err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO managed_devices(id,name,device_type_id,token_digest,terminal_enabled)
		VALUES($1,'Uncontrolled terminal',$2,$3,true)`, uuid.Must(uuid.NewV7()), deviceTypeID, bytes.Repeat([]byte{6}, 32))
	expectPostgresCode(t, err, "23514")

	person := seedAccount(t, pool, "attendance-constraints", false)
	firstVisit := uuid.Must(uuid.NewV7())
	if _, err = pool.Exec(ctx, `INSERT INTO visits(id,person_id,checked_in_at,status,check_in_method,check_in_assurance,admission_decision)
		VALUES($1,$2,now(),'checked_in','supervisor','normal','admitted')`, firstVisit, person.personID); err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO visits(id,person_id,checked_in_at,status,check_in_method,check_in_assurance,admission_decision)
		VALUES($1,$2,now(),'checked_in','supervisor','normal','admitted')`, uuid.Must(uuid.NewV7()), person.personID)
	expectPostgresCode(t, err, "23505")
	_, err = pool.Exec(ctx, `UPDATE visits SET status='checked_out', checked_out_at=checked_in_at-interval '1 second', check_out_method='supervisor' WHERE id=$1`, firstVisit)
	expectPostgresCode(t, err, "23514")
	if _, err = pool.Exec(ctx, `UPDATE visits SET status='checked_out', checked_out_at=checked_in_at+interval '1 minute', check_out_method='supervisor' WHERE id=$1`, firstVisit); err != nil {
		t.Fatal(err)
	}
	if _, err = attendancedb.New(pool).ArchiveExpiredVisitDetail(ctx, pgtype.Timestamptz{Time: time.Now().UTC().Add(2 * time.Hour), Valid: true}); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, "SELECT count(*) FROM visits WHERE id='"+firstVisit.String()+"'", 0)
	assertCount(t, pool, "SELECT count(*) FROM attendance_daily_statistics WHERE visitor_count=1 AND visitor_seconds=60", 1)

	voidVisit := uuid.Must(uuid.NewV7())
	if _, err = pool.Exec(ctx, `INSERT INTO visits(id,person_id,checked_in_at,status,check_in_method,check_in_assurance,admission_decision)
		VALUES($1,$2,now(),'checked_in','supervisor','normal','admitted')`, voidVisit, person.personID); err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `UPDATE visits SET status='voided' WHERE id=$1`, voidVisit)
	expectPostgresCode(t, err, "23514")
	if _, err = pool.Exec(ctx, `UPDATE visits SET status='voided', correction_reason='duplicate entry' WHERE id=$1`, voidVisit); err != nil {
		t.Fatal(err)
	}

	surveyID, versionID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	if _, err = pool.Exec(ctx, `INSERT INTO surveys(id,name,anonymous) VALUES($1,'Anonymous survey',true)`, surveyID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO survey_versions(id,survey_id,revision,title) VALUES($1,$2,1,'Feedback')`, versionID, surveyID); err != nil {
		t.Fatal(err)
	}
	responseID := uuid.Must(uuid.NewV7())
	if _, err = pool.Exec(ctx, `INSERT INTO survey_responses(id,survey_version_id,submitted_on) VALUES($1,$2,current_date)`, responseID, versionID); err != nil {
		t.Fatal(err)
	}
	var directPersonID *uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT identified_person_id FROM survey_responses WHERE id=$1`, responseID).Scan(&directPersonID); err != nil {
		t.Fatal(err)
	}
	if directPersonID != nil {
		t.Fatal("anonymous response retained a direct person identifier")
	}
	_, err = pool.Exec(ctx, `INSERT INTO survey_responses(id,survey_version_id,submitted_on,identified_person_id)
		VALUES($1,$2,current_date,$3)`, uuid.Must(uuid.NewV7()), versionID, person.personID)
	expectPostgresCode(t, err, "23514")

	questionA, questionB, optionA := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	if _, err = pool.Exec(ctx, `INSERT INTO survey_questions(id,survey_version_id,kind,prompt,position) VALUES
		($1,$3,'single_choice','First',1),($2,$3,'single_choice','Second',2)`, questionA, questionB, versionID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO survey_question_options(id,question_id,label,position) VALUES($1,$2,'Choice',1)`, optionA, questionA); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE survey_versions SET published_at=now() WHERE id=$1`, versionID); err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `UPDATE survey_versions SET title='Changed after publication' WHERE id=$1`, versionID)
	expectPostgresCode(t, err, "23514")
	_, err = pool.Exec(ctx, `UPDATE survey_questions SET prompt='Changed after publication' WHERE id=$1`, questionA)
	expectPostgresCode(t, err, "23514")
	_, err = pool.Exec(ctx, `UPDATE survey_question_options SET label='Changed after publication' WHERE id=$1`, optionA)
	expectPostgresCode(t, err, "23514")
	_, err = pool.Exec(ctx, `INSERT INTO survey_answers(id,response_id,question_id,option_id)
		VALUES($1,$2,$3,$4)`, uuid.Must(uuid.NewV7()), responseID, questionB, optionA)
	expectPostgresCode(t, err, "23503")
	secondVersion, questionC := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	if _, err = pool.Exec(ctx, `INSERT INTO survey_versions(id,survey_id,revision,title) VALUES($1,$2,2,'Later feedback');
		INSERT INTO survey_questions(id,survey_version_id,kind,prompt,position) VALUES($3,$1,'free_text','Later question',1)`, secondVersion, surveyID, questionC); err != nil {
		t.Fatal(err)
	}
	answerText := "cross-version"
	_, err = pool.Exec(ctx, `INSERT INTO survey_answers(id,response_id,question_id,text_value)
		VALUES($1,$2,$3,$4)`, uuid.Must(uuid.NewV7()), responseID, questionC, answerText)
	expectPostgresCode(t, err, "23514")

	invitationID := uuid.Must(uuid.NewV7())
	if _, err = pool.Exec(ctx, `INSERT INTO survey_invitations(id,survey_version_id,person_id,token_digest,recipient_email,due_at,expires_at)
		VALUES($1,$2,$3,$4,'visitor@example.test',now()-interval '3 days',now()-interval '2 days')`, invitationID, versionID, person.personID, bytes.Repeat([]byte{7}, 32)); err != nil {
		t.Fatal(err)
	}
	if _, err = surveysdb.New(pool).DeleteExpiredSurveyInvitationPII(ctx, time.Now().UTC().Add(-24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	var invitationStatus string
	var retainedPersonID *uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT status,person_id FROM survey_invitations WHERE id=$1`, invitationID).Scan(&invitationStatus, &retainedPersonID); err != nil {
		t.Fatal(err)
	}
	if invitationStatus != "expired" || retainedPersonID != nil {
		t.Fatalf("expired invitation retained delivery identity: status=%s person=%v", invitationStatus, retainedPersonID)
	}

	// Existing direct SQL session fixtures remain compatible, while application
	// session creation always supplies the selected policy snapshot explicitly.
	_, err = pool.Exec(ctx, `INSERT INTO sessions(id,account_id,auth_identity_id,token_digest,csrf_digest,auth_method,idle_expires_at,absolute_expires_at)
		VALUES($1,$2,$3,$4,$5,'password',now()+interval '1 hour',now()+interval '2 hours')`, uuid.Must(uuid.NewV7()), person.accountID, person.identity, bytes.Repeat([]byte{8}, 32), bytes.Repeat([]byte{9}, 32))
	if err != nil {
		t.Fatal(err)
	}
}

func TestTerminalAttendanceSurveyMigrationRoundTrip(t *testing.T) {
	pool := emptySchemaPool(t)
	paths := orderedMigrationFiles(t)
	if filepath.Base(paths[29]) != "00030_terminal_attendance_surveys.sql" {
		t.Fatal(paths[29])
	}
	applyMigrationFiles(t, pool, paths[:29])
	up, down := migrationParts(t, paths[29])
	if _, err := pool.Exec(testContext(t), up); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(testContext(t), down); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(testContext(t), up); err != nil {
		t.Fatal(err)
	}
}

func migrationParts(t *testing.T, path string) (string, string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	up, down, ok := strings.Cut(string(raw), "-- +goose Down")
	if !ok {
		t.Fatal("migration has no Down section")
	}
	return up, down
}
