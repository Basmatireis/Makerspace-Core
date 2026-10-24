package integration_test

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/surveys"
)

type surveyNotifierStub struct {
	fail bool
	sent int
}

func (n *surveyNotifierStub) SendSurveyInvitation(context.Context, string, string, string, time.Time) error {
	if n.fail {
		return errors.New("mail provider unavailable")
	}
	n.sent++
	return nil
}

// A failed send waits before the next attempt, so the per-minute delivery loop does not burn through every attempt
// during a short mail outage.
func TestSurveyDeliveryBacksOffAfterAFailedSend(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	person := seedAccount(t, pool, "survey-delivery", false)
	surveyID, versionID, invitationID := ids.New(), ids.New(), ids.New()
	if _, err := pool.Exec(ctx, `INSERT INTO surveys(id,name,anonymous) VALUES($1,'Delivery survey',false)`, surveyID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO survey_versions(id,survey_id,revision,title) VALUES($1,$2,1,'Feedback')`,
		versionID,
		surveyID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO survey_invitations(id,survey_version_id,person_id,token_digest,recipient_email,due_at,expires_at)
		VALUES($1,$2,$3,$4,'visitor@example.test',now()-interval '1 minute',now()+interval '7 days')`,
		invitationID, versionID, person.personID, bytes.Repeat([]byte{9}, 32)); err != nil {
		t.Fatal(err)
	}

	notifier := &surveyNotifierStub{fail: true}
	service := surveys.NewService(pool, config.Config{ChallengeHMACKey: bytes.Repeat([]byte{1}, 32)}, notifier)
	if delivered, err := service.DeliverDue(ctx, 10); err != nil || delivered != 0 {
		t.Fatalf("failed pass delivered %d, err %v", delivered, err)
	}
	var status string
	var waitsAtLeastFiveMinutes bool
	if err := pool.QueryRow(ctx, `SELECT status, due_at >= now() + interval '4 minutes' FROM survey_invitations WHERE id = $1`,
		invitationID).Scan(&status, &waitsAtLeastFiveMinutes); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || !waitsAtLeastFiveMinutes {
		t.Fatalf("status = %s, backed off = %v", status, waitsAtLeastFiveMinutes)
	}

	// The next minute's pass leaves it alone; once the wait is over it is sent.
	notifier.fail = false
	if delivered, err := service.DeliverDue(ctx, 10); err != nil || delivered != 0 || notifier.sent != 0 {
		t.Fatalf("pass during back-off delivered %d (sent %d), err %v", delivered, notifier.sent, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE survey_invitations SET due_at = now() - interval '1 second' WHERE id = $1`,
		invitationID); err != nil {
		t.Fatal(err)
	}
	if delivered, err := service.DeliverDue(ctx, 10); err != nil || delivered != 1 || notifier.sent != 1 {
		t.Fatalf("pass after back-off delivered %d (sent %d), err %v", delivered, notifier.sent, err)
	}
}
