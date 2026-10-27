package integration_test

import (
	"bytes"
	"encoding/csv"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/surveys"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type surveyEnv struct {
	t       *testing.T
	pool    *pgxpool.Pool
	svc     *surveys.Service
	master  authorization.Principal
	account seededAccount
}

func newSurveyEnv(t *testing.T) *surveyEnv {
	t.Helper()
	pool := migratedPool(t)
	account := seedAccount(t, pool, "survey-master", true)
	return &surveyEnv{
		t:       t,
		pool:    pool,
		svc:     surveys.NewService(pool, config.Config{ChallengeHMACKey: bytes.Repeat([]byte{1}, 32)}, nil),
		master:  authorization.Principal{AccountID: account.accountID, PersonID: account.personID, Master: true},
		account: account,
	}
}

// staff is a principal that holds exactly the given permissions through a role.
func (e *surveyEnv) staff(suffix string, permissions ...authorization.Permission) authorization.Principal {
	e.t.Helper()
	ctx := testContext(e.t)
	account := seedAccount(e.t, e.pool, "survey-"+suffix, false)
	roleID := ids.New()
	if _, err := e.pool.Exec(ctx, `INSERT INTO roles (id, name) VALUES ($1, $2)`, roleID, "Survey "+suffix); err != nil {
		e.t.Fatal(err)
	}
	for _, permission := range permissions {
		if _, err := e.pool.Exec(
			ctx,
			`INSERT INTO role_permission_grants (id, role_id, permission_id) VALUES (uuidv7(), $1, $2)`,
			roleID,
			permission,
		); err != nil {
			e.t.Fatal(err)
		}
	}
	if _, err := e.pool.Exec(ctx, `INSERT INTO person_roles (person_id, role_id) VALUES ($1, $2)`, account.personID, roleID); err != nil {
		e.t.Fatal(err)
	}
	principal, err := authorization.LoadPermissionsFrom(
		ctx,
		e.pool,
		authorization.Principal{AccountID: account.accountID, PersonID: account.personID, Assurance: authorization.AssuranceNormal},
	)
	if err != nil {
		e.t.Fatal(err)
	}
	return principal
}

func i32(value int32) *int32 { return &value }

// conditionalSurvey is: Q1 single choice (Yes/No), Q2 required free text shown only for "Yes", Q3 optional rating.
func conditionalSurveyInput(name string, anonymous bool) surveys.Input {
	return surveys.Input{
		Name:      name,
		Title:     "Feedback",
		Anonymous: anonymous,
		Questions: []surveys.QuestionInput{
			{Kind: surveys.QuestionSingleChoice, Prompt: "Happy?", Required: true,
				Options: []surveys.OptionInput{{Label: "Yes"}, {Label: "No"}}},
			{Kind: surveys.QuestionFreeText, Prompt: "Why?", Required: true,
				Condition: &surveys.ConditionInput{
					QuestionPosition: 1, Operator: surveys.ConditionOneOf, OptionPositions: []int{1},
				}},
			{Kind: surveys.QuestionRating, Prompt: "Score", RatingMin: i32(1), RatingMax: i32(5)},
		},
	}
}

func (e *surveyEnv) published(input surveys.Input) surveys.Survey {
	e.t.Helper()
	ctx := testContext(e.t)
	created, err := e.svc.Create(ctx, e.master, input, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	published, err := e.svc.Publish(ctx, e.master, created.ID, created.Version, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	return published
}

func (e *surveyEnv) link(survey surveys.Survey, input surveys.LinkInput) surveys.ShareLink {
	e.t.Helper()
	link, err := e.svc.CreateLink(testContext(e.t), e.master, survey.ID, input, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	return link
}

func appCode(err error) string {
	var appErr *apperror.Error
	if errors.As(err, &appErr) {
		return appErr.Code
	}
	return ""
}

func answerChoice(question surveys.Question, label string) surveys.AnswerInput {
	for _, option := range question.Options {
		if option.Label == label {
			return surveys.AnswerInput{QuestionID: question.ID, OptionIDs: []uuid.UUID{option.ID}}
		}
	}
	panic("unknown option " + label)
}

func text(question surveys.Question, value string) surveys.AnswerInput {
	return surveys.AnswerInput{QuestionID: question.ID, TextValue: &value}
}

func TestSurveyConditionsAreStoredAndEnforcedOnSubmit(t *testing.T) {
	e := newSurveyEnv(t)
	ctx := testContext(t)
	survey := e.published(conditionalSurveyInput("Conditional", true))
	q := survey.Questions
	if c := q[1].Condition; c == nil || c.QuestionID != q[0].ID || c.QuestionPosition != 1 ||
		len(c.OptionIDs) != 1 || c.OptionIDs[0] != q[0].Options[0].ID {
		t.Fatalf("condition was not stored against the earlier question: %+v", q[1].Condition)
	}
	link := e.link(survey, surveys.LinkInput{Active: true})

	// "No" hides Q2: it is not required and cannot be answered.
	if err := e.svc.SubmitByLink(ctx, link.Token, []surveys.AnswerInput{answerChoice(q[0], "No")}); err != nil {
		t.Fatalf("hidden required question blocked the submission: %v", err)
	}
	err := e.svc.SubmitByLink(ctx, link.Token, []surveys.AnswerInput{answerChoice(q[0], "No"), text(q[1], "stale")})
	if appCode(err) != "survey_answer_not_applicable" {
		t.Fatalf("answer to a hidden question: %v", err)
	}
	// "Yes" shows Q2 and makes it required.
	if err = e.svc.SubmitByLink(ctx, link.Token, []surveys.AnswerInput{answerChoice(q[0], "Yes")}); err == nil {
		t.Fatal("a visible required question was skipped")
	}
	if err = e.svc.SubmitByLink(ctx, link.Token, []surveys.AnswerInput{answerChoice(q[0], "Yes"), text(q[1], "great")}); err != nil {
		t.Fatal(err)
	}
	var stored int
	if err = e.pool.QueryRow(ctx, `SELECT count(*) FROM survey_answers WHERE question_id = $1`, q[1].ID).Scan(&stored); err != nil || stored != 1 {
		t.Fatalf("answers stored for the conditional question = %d, err %v", stored, err)
	}

	// A condition may only refer to an earlier question and must fit its kind.
	bad := conditionalSurveyInput("Bad", true)
	bad.Questions[0], bad.Questions[1] = bad.Questions[1], bad.Questions[0]
	if _, err = e.svc.Create(ctx, e.master, bad, nil); err == nil {
		t.Fatal("a condition on a later question was accepted")
	}
}

func TestPublishedSurveyIsEditableAndDeletableOnlyWithoutResponses(t *testing.T) {
	e := newSurveyEnv(t)
	ctx := testContext(t)
	survey := e.published(conditionalSurveyInput("Editable", true))
	link := e.link(survey, surveys.LinkInput{Active: true})
	oldQuestionID := survey.Questions[0].ID

	edited := conditionalSurveyInput("Editable renamed", true)
	edited.Title = "Changed title"
	edited.ExpectedVersion = survey.Version
	updated, err := e.svc.Update(ctx, e.master, survey.ID, edited, nil)
	if err != nil {
		t.Fatalf("edit of a published survey without responses: %v", err)
	}
	if updated.Status != surveys.StatusPublished || updated.Title != "Changed title" || updated.Revision != survey.Revision ||
		updated.Questions[0].ID == oldQuestionID || updated.Questions[1].Condition == nil {
		t.Fatalf("unexpected edited survey: %+v", updated)
	}

	if err = e.svc.SubmitByLink(ctx, link.Token, []surveys.AnswerInput{answerChoice(updated.Questions[0], "No")}); err != nil {
		t.Fatal(err)
	}
	edited.ExpectedVersion = updated.Version
	if _, err = e.svc.Update(ctx, e.master, survey.ID, edited, nil); appCode(err) != "survey_has_responses" {
		t.Fatalf("edit with responses: %v", err)
	}
	if err = e.svc.Delete(ctx, e.master, survey.ID, nil); appCode(err) != "survey_has_responses" {
		t.Fatalf("delete with responses: %v", err)
	}
	// The database refuses it too, whatever the service does.
	if _, err = e.pool.Exec(ctx, `UPDATE survey_versions SET title = 'Tampered' WHERE survey_id = $1`, survey.ID); err == nil {
		t.Fatal("a version with responses was updated directly")
	}
	if _, err = e.pool.Exec(ctx, `DELETE FROM survey_questions WHERE survey_version_id IN (SELECT id FROM survey_versions WHERE survey_id = $1)`, survey.ID); err == nil {
		t.Fatal("questions of a version with responses were deleted directly")
	}
}

func TestDeletingASurveyWithoutResponsesRemovesEverythingAndIsAudited(t *testing.T) {
	e := newSurveyEnv(t)
	ctx := testContext(t)
	person := seedAccount(t, e.pool, "survey-invitee", false)
	survey := e.published(conditionalSurveyInput("Disposable", false))
	e.link(survey, surveys.LinkInput{Active: true})
	if _, err := e.svc.UpdateTrigger(ctx, e.master, survey.ID, true, 60, 1, 0, nil); err != nil {
		t.Fatal(err)
	}
	var versionID uuid.UUID
	if err := e.pool.QueryRow(ctx, `SELECT id FROM survey_versions WHERE survey_id = $1`, survey.ID).Scan(&versionID); err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"pending", "cancelled"} {
		personID := &person.personID
		if status == "cancelled" {
			personID = nil
		}
		if _, err := e.pool.Exec(ctx, `INSERT INTO survey_invitations(id,survey_version_id,person_id,token_digest,recipient_email,status,due_at,expires_at)
			VALUES($1,$2,$3,$4,$5,$6,now(),now()+interval '1 day')`,
			ids.New(), versionID, personID, security.DigestToken(ids.New().String()+status), nil, status); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.svc.Delete(ctx, e.master, survey.ID, nil); err != nil {
		t.Fatalf("delete: %v", err)
	}
	var leftovers int
	if err := e.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM surveys WHERE id = $1) + (SELECT count(*) FROM survey_versions WHERE id = $2)
		+ (SELECT count(*) FROM survey_triggers WHERE survey_id = $1) + (SELECT count(*) FROM survey_share_links WHERE survey_id = $1)
		+ (SELECT count(*) FROM survey_invitations WHERE survey_version_id = $2)`, survey.ID, versionID).Scan(&leftovers); err != nil || leftovers != 0 {
		t.Fatalf("rows left after deletion = %d, err %v", leftovers, err)
	}
	var audited int
	if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action = 'survey.deleted' AND resource_id = $1`, survey.ID).Scan(&audited); err != nil || audited != 1 {
		t.Fatalf("survey.deleted audit events = %d, err %v", audited, err)
	}
	if err := e.svc.Delete(ctx, e.master, survey.ID, nil); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("second delete: %v", err)
	}
}

func TestReopenedSurveyAcceptsAnswersButKeepsTriggerAndCancelledInvitationsOff(t *testing.T) {
	e := newSurveyEnv(t)
	ctx := testContext(t)
	person := seedAccount(t, e.pool, "survey-reopen", false)
	survey := e.published(conditionalSurveyInput("Reopen", false))
	link := e.link(survey, surveys.LinkInput{Active: true})
	trigger, err := e.svc.UpdateTrigger(ctx, e.master, survey.ID, true, 60, 1, 0, nil)
	if err != nil || !trigger.Enabled {
		t.Fatalf("trigger: %+v, %v", trigger, err)
	}
	var versionID uuid.UUID
	if err = e.pool.QueryRow(ctx, `SELECT id FROM survey_versions WHERE survey_id = $1`, survey.ID).Scan(&versionID); err != nil {
		t.Fatal(err)
	}
	invitationID := ids.New()
	if _, err = e.pool.Exec(ctx, `INSERT INTO survey_invitations(id,survey_version_id,person_id,token_digest,recipient_email,status,due_at,expires_at)
		VALUES($1,$2,$3,$4,'x@example.test','sent',now()-interval '1 hour',now()+interval '1 day')`,
		invitationID, versionID, person.personID, security.DigestToken("reopen-invitation-token")); err != nil {
		t.Fatal(err)
	}
	current, err := e.svc.Get(ctx, e.master, survey.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.svc.Reopen(ctx, e.master, survey.ID, current.Version, nil); !errors.Is(err, apperror.StaleWrite) {
		t.Fatalf("reopening a published survey: %v", err)
	}
	closed, err := e.svc.Close(ctx, e.master, survey.ID, current.Version, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = e.svc.SubmitByLink(ctx, link.Token, []surveys.AnswerInput{answerChoice(survey.Questions[0], "No")}); appCode(err) != "survey_unavailable" {
		t.Fatalf("closed survey link: %v", err)
	}
	reopened, err := e.svc.Reopen(ctx, e.master, survey.ID, closed.Version, nil)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Status != surveys.StatusPublished || reopened.Trigger == nil || reopened.Trigger.Enabled {
		t.Fatalf("reopened survey: status %s, trigger %+v", reopened.Status, reopened.Trigger)
	}
	var status string
	if err = e.pool.QueryRow(ctx, `SELECT status FROM survey_invitations WHERE id = $1`, invitationID).Scan(&status); err != nil || status != "cancelled" {
		t.Fatalf("invitation after reopen = %q, err %v", status, err)
	}
	if err = e.svc.Submit(ctx, "reopen-invitation-token", nil); appCode(err) != "survey_invitation_unavailable" {
		t.Fatalf("cancelled invitation: %v", err)
	}
	if err = e.svc.SubmitByLink(ctx, link.Token, []surveys.AnswerInput{answerChoice(survey.Questions[0], "No")}); err != nil {
		t.Fatalf("reopened survey link: %v", err)
	}
}

func TestShareLinksAreAnonymousAndHonourExpiryActiveFlagAndLimit(t *testing.T) {
	e := newSurveyEnv(t)
	ctx := testContext(t)
	survey := e.published(conditionalSurveyInput("Links", false)) // identified survey: links must still be anonymous
	no := []surveys.AnswerInput{answerChoice(survey.Questions[0], "No")}

	limited := e.link(survey, surveys.LinkInput{Label: stringPtr("  Open day  "), MaxResponses: i32(1), Active: true})
	if limited.Label == nil || *limited.Label != "Open day" || limited.State != surveys.LinkOpen || len(limited.Token) != 43 {
		t.Fatalf("created link: %+v", limited)
	}
	listed, err := e.svc.ListLinks(ctx, e.master, survey.ID)
	if err != nil || len(listed) != 1 || listed[0].Token != limited.Token {
		t.Fatalf("the token must be shown again: %+v, %v", listed, err)
	}
	public, err := e.svc.PublicByLink(ctx, limited.Token)
	if err != nil || !public.Anonymous || public.ExpiresAt != nil {
		t.Fatalf("public survey: %+v, %v", public, err)
	}
	if err = e.svc.SubmitByLink(ctx, limited.Token, no); err != nil {
		t.Fatal(err)
	}
	if err = e.svc.SubmitByLink(ctx, limited.Token, no); appCode(err) != "survey_link_full" {
		t.Fatalf("second response through a link with maxResponses 1: %v", err)
	}
	var identified *uuid.UUID
	var source string
	var linkID *uuid.UUID
	if err = e.pool.QueryRow(ctx, `SELECT identified_person_id, source, share_link_id FROM survey_responses`).Scan(&identified, &source, &linkID); err != nil {
		t.Fatal(err)
	}
	if identified != nil || source != "link" || linkID == nil || *linkID != limited.ID {
		t.Fatalf("link response: person %v, source %s, link %v", identified, source, linkID)
	}

	// Deactivate, reactivate with room, then expire.
	current := listed[0]
	update := func(input surveys.LinkInput) surveys.ShareLink {
		t.Helper()
		input.ExpectedVersion = current.Version
		updated, updateErr := e.svc.UpdateLink(ctx, e.master, survey.ID, limited.ID, input, nil)
		if updateErr != nil {
			t.Fatal(updateErr)
		}
		current = updated
		return updated
	}
	update(surveys.LinkInput{MaxResponses: i32(5), Active: false})
	if err = e.svc.SubmitByLink(ctx, limited.Token, no); appCode(err) != "survey_link_inactive" {
		t.Fatalf("inactive link: %v", err)
	}
	if _, err = e.svc.PublicByLink(ctx, limited.Token); appCode(err) != "survey_link_inactive" {
		t.Fatalf("inactive link read: %v", err)
	}
	if reactivated := update(surveys.LinkInput{MaxResponses: i32(5), Active: true}); reactivated.State != surveys.LinkOpen || reactivated.Token != limited.Token {
		t.Fatalf("reactivated link: %+v", reactivated)
	}
	if err = e.svc.SubmitByLink(ctx, limited.Token, no); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Minute)
	if expired := update(surveys.LinkInput{ExpiresAt: &past, Active: true}); expired.State != surveys.LinkExpired {
		t.Fatalf("expired link: %+v", expired)
	}
	if err = e.svc.SubmitByLink(ctx, limited.Token, no); appCode(err) != "survey_link_expired" {
		t.Fatalf("expired link: %v", err)
	}
	stale := surveys.LinkInput{Active: true, ExpectedVersion: 1}
	if _, err = e.svc.UpdateLink(ctx, e.master, survey.ID, limited.ID, stale, nil); !errors.Is(err, apperror.StaleWrite) {
		t.Fatalf("stale link update: %v", err)
	}
	if _, err = e.svc.CreateLink(ctx, e.master, survey.ID, surveys.LinkInput{ExpiresAt: &past, Active: true}, nil); err == nil {
		t.Fatal("a link that is already expired was created")
	}
	if _, err = e.svc.PublicByLink(ctx, strings.Repeat("A", 43)); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("unknown token: %v", err)
	}

	// Deleting the link keeps its responses.
	if err = e.svc.DeleteLink(ctx, e.master, survey.ID, limited.ID, nil); err != nil {
		t.Fatal(err)
	}
	var kept int
	if err = e.pool.QueryRow(ctx, `SELECT count(*) FROM survey_responses WHERE source = 'link' AND share_link_id IS NULL`).Scan(&kept); err != nil || kept != 2 {
		t.Fatalf("responses kept after deleting the link = %d, err %v", kept, err)
	}
	if err = e.svc.SubmitByLink(ctx, limited.Token, no); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("deleted link: %v", err)
	}
}

func stringPtr(value string) *string { return &value }

func TestSurveyResultsAggregateFilterAndExport(t *testing.T) {
	e := newSurveyEnv(t)
	ctx := testContext(t)
	person := seedAccount(t, e.pool, "survey-results", false)
	input := surveys.Input{
		Name: "Results", Title: "Results", Anonymous: false,
		Questions: []surveys.QuestionInput{
			{Kind: surveys.QuestionSingleChoice, Prompt: "Mood", Options: []surveys.OptionInput{{Label: "Good"}, {Label: "Bad"}}},
			{Kind: surveys.QuestionMultipleChoice, Prompt: "Used", Options: []surveys.OptionInput{{Label: "Laser"}, {Label: "Printer"}, {Label: "Saw"}}},
			{Kind: surveys.QuestionRating, Prompt: "Score", RatingMin: i32(1), RatingMax: i32(5)},
			{Kind: surveys.QuestionYesNo, Prompt: "Return?"},
			{Kind: surveys.QuestionFreeText, Prompt: "Comment"},
		},
	}
	survey := e.published(input)
	q := survey.Questions
	link := e.link(survey, surveys.LinkInput{Label: stringPtr("Flyer"), Active: true})
	yes, no := true, false
	rate := func(value int32) *int32 { return &value }
	multi := func(labels ...string) surveys.AnswerInput {
		answer := surveys.AnswerInput{QuestionID: q[1].ID}
		for _, label := range labels {
			answer.OptionIDs = append(answer.OptionIDs, answerChoice(q[1], label).OptionIDs...)
		}
		return answer
	}
	// Two link responses ...
	if err := e.svc.SubmitByLink(ctx, link.Token, []surveys.AnswerInput{
		answerChoice(q[0], "Good"), multi("Laser", "Saw"),
		{QuestionID: q[2].ID, NumericValue: rate(5)}, {QuestionID: q[3].ID, BooleanValue: &yes},
		text(q[4], "=HYPERLINK(\"http://evil.example\")"),
	}); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.SubmitByLink(ctx, link.Token, []surveys.AnswerInput{
		answerChoice(q[0], "Bad"), {QuestionID: q[2].ID, NumericValue: rate(2)}, {QuestionID: q[3].ID, BooleanValue: &no},
	}); err != nil {
		t.Fatal(err)
	}
	// ... and one identified invitation response.
	var versionID uuid.UUID
	if err := e.pool.QueryRow(ctx, `SELECT id FROM survey_versions WHERE survey_id = $1`, survey.ID).Scan(&versionID); err != nil {
		t.Fatal(err)
	}
	for index, token := range []string{"results-invitation-token-a", "results-invitation-token-b"} {
		status, sentAt := "sent", "now()"
		if index == 1 {
			status, sentAt = "pending", "NULL"
		}
		if _, err := e.pool.Exec(ctx, `INSERT INTO survey_invitations(id,survey_version_id,person_id,token_digest,recipient_email,status,due_at,sent_at,expires_at)
			VALUES($1,$2,$3,$4,'x@example.test',$5,now()-interval '1 hour',`+sentAt+`,now()+interval '1 day')`,
			ids.New(), versionID, person.personID, security.DigestToken(token), status); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.svc.Submit(ctx, "results-invitation-token-a", []surveys.AnswerInput{
		answerChoice(q[0], "Good"), multi("Printer"), {QuestionID: q[2].ID, NumericValue: rate(4)}, text(q[4], "Nice"),
	}); err != nil {
		t.Fatal(err)
	}

	overview, err := e.svc.Overview(ctx, e.master, survey.ID)
	if err != nil {
		t.Fatal(err)
	}
	if overview.Responses != 3 || overview.ResponsesByInvitation != 1 || overview.ResponsesByLink != 2 || overview.InvitationsSent != 1 ||
		overview.ResponseRate == nil || *overview.ResponseRate != 1 || overview.FirstResponseOn == nil || overview.LastResponseOn == nil ||
		len(overview.Links) != 1 || overview.Links[0].Responses != 2 {
		t.Fatalf("overview: %+v", overview)
	}

	results, err := e.svc.QuestionResults(ctx, e.master, survey.ID, surveys.ResultFilter{}, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	counts := func(result surveys.QuestionResult) map[string]int64 {
		m := map[string]int64{}
		for _, option := range result.Options {
			m[option.Label] = option.Count
		}
		return m
	}
	mood, used, score, again, comment := results.Questions[0], results.Questions[1], results.Questions[2], results.Questions[3], results.Questions[4]
	if results.TotalResponses != 3 || counts(mood)["Good"] != 2 || counts(mood)["Bad"] != 1 ||
		counts(used)["Laser"] != 1 || counts(used)["Printer"] != 1 || counts(used)["Saw"] != 1 || used.Respondents != 2 {
		t.Fatalf("choice aggregates: %+v", results)
	}
	if score.Rating == nil || score.Rating.Mean == nil || *score.Rating.Mean != 11.0/3 || len(score.Rating.Distribution) != 5 ||
		score.Rating.Distribution[4].Count != 1 || score.Rating.Distribution[0].Count != 0 {
		t.Fatalf("rating aggregate: %+v", score.Rating)
	}
	if again.YesNo == nil || again.YesNo.Yes != 1 || again.YesNo.No != 1 {
		t.Fatalf("yes/no aggregate: %+v", again.YesNo)
	}
	if comment.Text == nil || comment.Text.Total != 2 || len(comment.Text.Items) != 2 {
		t.Fatalf("text aggregate: %+v", comment.Text)
	}
	if paged, pageErr := e.svc.QuestionResults(ctx, e.master, survey.ID, surveys.ResultFilter{}, 1, 1); pageErr != nil ||
		len(paged.Questions[4].Text.Items) != 1 || paged.Questions[4].Text.Total != 2 {
		t.Fatalf("paged text: %+v, %v", paged.Questions[4].Text, pageErr)
	}

	link2 := surveys.SourceLink
	filtered, err := e.svc.QuestionResults(ctx, e.master, survey.ID, surveys.ResultFilter{Source: &link2, LinkID: &link.ID}, 10, 0)
	if err != nil || filtered.TotalResponses != 2 || counts(filtered.Questions[0])["Good"] != 1 {
		t.Fatalf("source filter: %+v, %v", filtered, err)
	}
	tomorrow := time.Now().Add(48 * time.Hour)
	empty, err := e.svc.QuestionResults(ctx, e.master, survey.ID, surveys.ResultFilter{From: &tomorrow}, 10, 0)
	if err != nil || empty.TotalResponses != 0 || empty.Questions[2].Rating.Mean != nil {
		t.Fatalf("date filter: %+v, %v", empty, err)
	}
	invitationSource := surveys.SourceInvitation
	if _, err = e.svc.QuestionResults(ctx, e.master, survey.ID, surveys.ResultFilter{Source: &invitationSource, LinkID: &link.ID}, 10, 0); err == nil {
		t.Fatal("a link filter combined with the invitation source was accepted")
	}

	content, err := e.svc.ExportCSV(ctx, e.master, survey.ID, surveys.ResultFilter{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := csv.NewReader(bytes.NewReader(content)).ReadAll()
	if err != nil || len(rows) != 4 {
		t.Fatalf("csv rows = %d, err %v\n%s", len(rows), err, content)
	}
	if strings.Join(rows[0], "|") != "Submitted on|Source|Person|Mood|Used|Score|Return?|Comment" {
		t.Fatalf("header: %v", rows[0])
	}
	var linkRow, invitationRow []string
	for _, row := range rows[1:] {
		if row[1] == "invitation" {
			invitationRow = row
		} else if row[3] == "Good" {
			linkRow = row
		}
	}
	if invitationRow[2] != "Test Person" || linkRow[2] != "" {
		t.Fatalf("person column: invitation %q, link %q", invitationRow[2], linkRow[2])
	}
	if linkRow[4] != "Laser; Saw" || linkRow[5] != "5" || linkRow[6] != "yes" || linkRow[7] != `'=HYPERLINK("http://evil.example")` {
		t.Fatalf("link row: %q", linkRow)
	}

	// An anonymous survey exports without any person column.
	anonymous := e.published(conditionalSurveyInput("Anonymous export", true))
	anonymousLink := e.link(anonymous, surveys.LinkInput{Active: true})
	if err = e.svc.SubmitByLink(ctx, anonymousLink.Token, []surveys.AnswerInput{answerChoice(anonymous.Questions[0], "No")}); err != nil {
		t.Fatal(err)
	}
	content, err = e.svc.ExportCSV(ctx, e.master, anonymous.ID, surveys.ResultFilter{}, nil)
	if err != nil || strings.Contains(string(content), "Person") {
		t.Fatalf("anonymous export: %v\n%s", err, content)
	}
}

func TestSurveyOperationsRequireTheirPermissions(t *testing.T) {
	e := newSurveyEnv(t)
	ctx := testContext(t)
	survey := e.published(conditionalSurveyInput("Permissions", true))
	closed, err := e.svc.Close(ctx, e.master, survey.ID, survey.Version, nil)
	if err != nil {
		t.Fatal(err)
	}
	link := e.link(closed, surveys.LinkInput{Active: true})
	readOnly := e.staff("read", authorization.SurveysRead)
	manageOnly := e.staff("manage", authorization.SurveysManage)
	nobody := e.staff("nobody")
	filter := surveys.ResultFilter{}

	denied := func(name string, err error) {
		t.Helper()
		if !errors.Is(err, apperror.PermissionDenied) {
			t.Errorf("%s: got %v, want permission denied", name, err)
		}
	}
	for name, principal := range map[string]authorization.Principal{"read-only": readOnly, "nobody": nobody} {
		_, err = e.svc.Reopen(ctx, principal, survey.ID, closed.Version, nil)
		denied(name+" reopen", err)
		denied(name+" delete", e.svc.Delete(ctx, principal, survey.ID, nil))
		_, err = e.svc.ListLinks(ctx, principal, survey.ID)
		denied(name+" list links", err)
		_, err = e.svc.CreateLink(ctx, principal, survey.ID, surveys.LinkInput{Active: true}, nil)
		denied(name+" create link", err)
		_, err = e.svc.UpdateLink(ctx, principal, survey.ID, link.ID, surveys.LinkInput{Active: true, ExpectedVersion: 1}, nil)
		denied(name+" update link", err)
		denied(name+" delete link", e.svc.DeleteLink(ctx, principal, survey.ID, link.ID, nil))
	}
	for name, principal := range map[string]authorization.Principal{"manage-only": manageOnly, "nobody": nobody} {
		_, err = e.svc.Overview(ctx, principal, survey.ID)
		denied(name+" overview", err)
		_, err = e.svc.QuestionResults(ctx, principal, survey.ID, filter, 10, 0)
		denied(name+" question results", err)
		_, err = e.svc.ExportCSV(ctx, principal, survey.ID, filter, nil)
		denied(name+" export", err)
	}
	// And the permitted principals work.
	if _, err = e.svc.ListLinks(ctx, manageOnly, survey.ID); err != nil {
		t.Errorf("manage list links: %v", err)
	}
	if _, err = e.svc.Overview(ctx, readOnly, survey.ID); err != nil {
		t.Errorf("read overview: %v", err)
	}
	if _, err = e.svc.ExportCSV(ctx, readOnly, survey.ID, filter, nil); err != nil {
		t.Errorf("read export: %v", err)
	}
	if reopened, reopenErr := e.svc.Reopen(ctx, manageOnly, survey.ID, closed.Version, nil); reopenErr != nil || reopened.Status != surveys.StatusPublished {
		t.Errorf("manage reopen: %v", reopenErr)
	}
	if err = e.svc.Delete(ctx, manageOnly, survey.ID, nil); err != nil {
		t.Errorf("manage delete: %v", err)
	}
}

func TestSurveyListFiltersSortsAndPages(t *testing.T) {
	e := newSurveyEnv(t)
	ctx := testContext(t)
	alpha := e.published(conditionalSurveyInput("Alpha list", true))
	if _, err := e.svc.Create(ctx, e.master, conditionalSurveyInput("Beta list", true), nil); err != nil {
		t.Fatal(err)
	}
	e.link(alpha, surveys.LinkInput{Active: true})
	link := e.link(alpha, surveys.LinkInput{Active: true})
	if err := e.svc.SubmitByLink(ctx, link.Token, []surveys.AnswerInput{answerChoice(alpha.Questions[0], "No")}); err != nil {
		t.Fatal(err)
	}
	items, total, err := e.svc.List(ctx, e.master, surveys.ListParams{Search: stringPtr("LIST"), Sort: "name", Limit: 10})
	if err != nil || total != 2 || len(items) != 2 || items[0].Name != "Alpha list" || items[0].ResponseCount != 1 || items[0].LinkCount != 2 {
		t.Fatalf("list: %+v, total %d, %v", items, total, err)
	}
	published := surveys.StatusPublished
	items, total, err = e.svc.List(ctx, e.master, surveys.ListParams{Search: stringPtr("list"), Status: &published, Sort: "name"})
	if err != nil || total != 1 || len(items) != 1 {
		t.Fatalf("status filter: %+v, total %d, %v", items, total, err)
	}
	items, total, err = e.svc.List(ctx, e.master, surveys.ListParams{Search: stringPtr("list"), Sort: "responseCount", Descending: true, Limit: 1, Skip: 1})
	if err != nil || total != 2 || len(items) != 1 || items[0].Name != "Beta list" {
		t.Fatalf("sorted page: %+v, total %d, %v", items, total, err)
	}
	if _, _, err = e.svc.List(ctx, e.staff("nobody-list"), surveys.ListParams{}); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("list without permission: %v", err)
	}
}

func TestSurveyHTTPBoundaries(t *testing.T) {
	pool := migratedPool(t)
	baseURL, err := url.Parse("http://makerspace.example.test")
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		PublicBaseURL:      baseURL,
		SessionCookieName:  "makerspace_session",
		CSRFCookieName:     "makerspace_csrf",
		SessionIdleTTL:     time.Hour,
		SessionAbsoluteTTL: time.Hour,
		PasswordResetTTL:   time.Hour,
		ChallengeHMACKey:   bytes.Repeat([]byte{1}, 32),
	}
	handler, err := httpapi.NewHandler(pool, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	api := server.URL + "/api/v1"
	id := ids.New().String()

	// Every staff operation of the survey feature refuses an anonymous caller.
	const linkBody = `{"label":null,"expiresAt":null,"maxResponses":null}`
	for _, endpoint := range []struct{ method, path, body string }{
		{http.MethodGet, "/surveys", ""}, {http.MethodDelete, "/surveys/" + id, ""},
		{http.MethodPost, "/surveys/" + id + "/reopen", `{"expectedVersion":1}`},
		{http.MethodGet, "/surveys/" + id + "/links", ""}, {http.MethodPost, "/surveys/" + id + "/links", linkBody},
		{http.MethodPut, "/surveys/" + id + "/links/" + id, `{"label":null,"expiresAt":null,"maxResponses":null,"active":true,"expectedVersion":1}`},
		{http.MethodDelete, "/surveys/" + id + "/links/" + id, ""},
		{http.MethodGet, "/surveys/" + id + "/results/overview", ""},
		{http.MethodGet, "/surveys/" + id + "/results/questions", ""},
		{http.MethodGet, "/surveys/" + id + "/results/export.csv", ""},
	} {
		request, _ := http.NewRequest(endpoint.method, api+endpoint.path, strings.NewReader(endpoint.body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", "http://makerspace.example.test")
		response, doErr := http.DefaultClient.Do(request)
		if doErr != nil {
			t.Fatal(doErr)
		}
		_ = response.Body.Close()
		// Mutations without the CSRF header are refused before the session is even looked at.
		if response.StatusCode != http.StatusUnauthorized && response.StatusCode != http.StatusForbidden {
			t.Errorf("%s %s without a session = %d", endpoint.method, endpoint.path, response.StatusCode)
		}
	}

	// The public link endpoints need no session, answer 404 for unknown tokens and throttle per client address.
	token := strings.Repeat("A", 43)
	response, err := http.Get(api + "/public/survey-links/" + token)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNotFound || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("unknown link: %d, cache %q", response.StatusCode, response.Header.Get("Cache-Control"))
	}
	var limited *http.Response
	for attempt := 0; attempt < 40 && limited == nil; attempt++ {
		request, _ := http.NewRequest(http.MethodPost, api+"/public/survey-links/"+token, strings.NewReader(`{"answers":[]}`))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", "http://makerspace.example.test")
		response, err = http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode == http.StatusTooManyRequests {
			limited = response
		} else if response.StatusCode != http.StatusNotFound {
			t.Fatalf("unknown link submit = %d", response.StatusCode)
		}
	}
	if limited == nil || limited.Header.Get("Retry-After") == "" {
		t.Fatal("anonymous link submissions are not throttled per client address")
	}
}
