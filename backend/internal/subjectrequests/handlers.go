package subjectrequests

import (
	"context"
	"io"
	"strconv"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacycatalog"
	requestsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/subjectrequests/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// exportFunc reads one category's document for the subject.
type exportFunc func(ctx context.Context, q *requestsdb.Queries, subject privacy.DataSubject) ([]byte, error)

// countFunc counts the subject's records of one category.
type countFunc func(ctx context.Context, q *requestsdb.Queries, subject privacy.DataSubject) (int64, error)

// builtin is a subject handler whose erasure happens through the person
// deletion (the database cascade or SET NULL rules of the foreign keys), so
// Erase only counts and declares the outcome. Account-linked categories are
// empty for a person without an account.
type builtin struct {
	export  exportFunc
	count   countFunc
	account bool
	outcome privacy.EraseOutcome
	note    string
	files   func(ctx context.Context, q *requestsdb.Queries, subject privacy.DataSubject) ([]privacy.ExportFile, error)
}

const emptyList = "[]"

func (h builtin) Export(ctx context.Context, tx pgx.Tx, subject privacy.DataSubject) (privacy.ExportSection, error) {
	if h.account && subject.AccountID == nil {
		return privacy.ExportSection{JSON: []byte(emptyList)}, nil
	}
	q := requestsdb.New(tx)
	document, err := h.export(ctx, q, subject)
	if err != nil {
		return privacy.ExportSection{}, err
	}
	if len(document) == 0 {
		document = []byte("null")
	}
	records, err := h.count(ctx, q, subject)
	if err != nil {
		return privacy.ExportSection{}, err
	}
	section := privacy.ExportSection{Records: records, JSON: document}
	if h.files != nil {
		if section.Files, err = h.files(ctx, q, subject); err != nil {
			return privacy.ExportSection{}, err
		}
	}
	return section, nil
}

func (h builtin) Erase(ctx context.Context, tx pgx.Tx, subject privacy.DataSubject) (privacy.EraseResult, error) {
	if h.account && subject.AccountID == nil {
		return privacy.EraseResult{Outcome: h.outcome, Note: h.note}, nil
	}
	records, err := h.count(ctx, requestsdb.New(tx), subject)
	if err != nil {
		return privacy.EraseResult{}, err
	}
	return privacy.EraseResult{Outcome: h.outcome, Records: records, Note: h.note}, nil
}

func account(subject privacy.DataSubject) uuid.UUID {
	if subject.AccountID == nil {
		return uuid.Nil
	}
	return *subject.AccountID
}

func registerBuiltinHandlers(service *privacy.Service, fileService *files.Service) {
	register := func(id privacy.CategoryID, handler builtin) { service.RegisterSubjectHandler(id, handler) }

	register(privacycatalog.PeopleIdentity, builtin{
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			return q.ExportPersonIdentity(ctx, s.PersonID)
		},
		count: func(context.Context, *requestsdb.Queries, privacy.DataSubject) (int64, error) { return 1, nil },
		files: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]privacy.ExportFile, error) {
			person, err := q.GetSubjectPerson(ctx, s.PersonID)
			if err != nil || person.ProfileImageFileID == nil || fileService == nil {
				return nil, err
			}
			fileID := *person.ProfileImageFileID
			return []privacy.ExportFile{{Name: "profile-image.jpg", ContentType: "image/jpeg", Open: func(ctx context.Context) (io.ReadCloser, error) {
				_, reader, err := fileService.Open(ctx, fileID)
				return reader, err
			}}}, nil
		},
		outcome: privacy.OutcomeErased, note: "The person record and its profile image are deleted.",
	})
	register(privacycatalog.AccountsCredentials, builtin{
		account: true,
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			return q.ExportAccount(ctx, account(s))
		},
		count:   func(context.Context, *requestsdb.Queries, privacy.DataSubject) (int64, error) { return 1, nil },
		outcome: privacy.OutcomeErased, note: "The account, its identities and second factors are deleted with the person.",
	})
	register(privacycatalog.AuthSessions, builtin{
		account: true,
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			return q.ExportSessions(ctx, account(s))
		},
		count: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) (int64, error) {
			return q.CountSessions(ctx, account(s))
		},
		outcome: privacy.OutcomeErased,
	})
	register(privacycatalog.AuthPendingState, builtin{
		account: true,
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			return q.ExportPendingState(ctx, account(s))
		},
		count: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) (int64, error) {
			return q.CountPendingState(ctx, account(s))
		},
		outcome: privacy.OutcomeErased,
	})
	register(privacycatalog.SCIMMappings, builtin{
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			return q.ExportScimMappings(ctx, s.PersonID)
		},
		count: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) (int64, error) {
			return q.CountScimMappings(ctx, s.PersonID)
		},
		outcome: privacy.OutcomeManualReview, note: "A SCIM-provisioned person must be deprovisioned in the identity provider; the mapping blocks deletion.",
	})
	register(privacycatalog.AttendanceVisits, builtin{
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			return q.ExportVisits(ctx, s.PersonID)
		},
		count: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) (int64, error) {
			return q.CountVisits(ctx, s.PersonID)
		},
		outcome: privacy.OutcomeErased, note: "Daily attendance statistics are already aggregated and keep no person.",
	})
	register(privacycatalog.SurveyInvitations, builtin{
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			return q.ExportSurveyInvitations(ctx, s.PersonID)
		},
		count: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) (int64, error) {
			return q.CountSurveyInvitations(ctx, s.PersonID)
		},
		outcome: privacy.OutcomeErased,
	})
	register(privacycatalog.SurveyResponses, builtin{
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			return q.ExportSurveyResponses(ctx, s.PersonID)
		},
		count: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) (int64, error) {
			return q.CountSurveyResponses(ctx, s.PersonID)
		},
		outcome: privacy.OutcomeUnlinked, note: "Responses stay as anonymous survey results without the person.",
	})
	register(privacycatalog.EventExternalSignups, builtin{
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			return q.ExportEventSignups(ctx, s.PersonID)
		},
		count: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) (int64, error) {
			return q.CountEventSignups(ctx, s.PersonID)
		},
		outcome: privacy.OutcomeErased, note: "Shift assignments of the person are deleted; sign-ups made without a person record are reached by retention.",
	})
	register(privacycatalog.EventContent, builtin{
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			return q.ExportEventContent(ctx, s.PersonID)
		},
		count: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) (int64, error) {
			return q.CountEventContent(ctx, s.PersonID)
		},
		outcome: privacy.OutcomeUnlinked, note: "Events and tasks stay without their owner or assignee.",
	})
	register(privacycatalog.OpenDayAssignments, builtin{
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			return q.ExportOpenDayAssignments(ctx, s.PersonID)
		},
		count: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) (int64, error) {
			return q.CountOpenDayAssignments(ctx, s.PersonID)
		},
		outcome: privacy.OutcomeErased,
	})
	register(privacycatalog.TrainingRecords, builtin{
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			return q.ExportTrainingRecords(ctx, s.PersonID)
		},
		count: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) (int64, error) {
			return q.CountTrainingRecords(ctx, s.PersonID)
		},
		outcome: privacy.OutcomeErased,
	})
	register(privacycatalog.LabRulesRequests, builtin{
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			return q.ExportLabRulesRequests(ctx, s.PersonID)
		},
		count: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) (int64, error) {
			return q.CountLabRulesRequests(ctx, s.PersonID)
		},
		outcome: privacy.OutcomeErased, note: "The physical confirmation document is outside the system; its archive reference is deleted.",
	})
	register(privacycatalog.AuditEvents, builtin{
		account: true,
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			return q.ExportAuditEvents(ctx, account(s))
		},
		count: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) (int64, error) {
			return q.CountAuditEvents(ctx, account(s))
		},
		outcome: privacy.OutcomeRetainedLegal, note: "Audit events stay without their actor until audit retention removes them.",
	})
	register(privacycatalog.OrdersFinancialRecords, builtin{
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			return q.ExportFinancialRecords(ctx, s.PersonID)
		},
		count: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) (int64, error) {
			return q.CountFinancialRecords(ctx, s.PersonID)
		},
		outcome: privacy.OutcomeRetainedLegal, note: "Orders, payments and invoice requests keep their snapshots for the statutory bookkeeping period; the person link is removed.",
	})
	register(privacycatalog.OrdersIdempotency, builtin{
		account: true,
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			count, err := q.CountOrderOperations(ctx, account(s))
			return []byte(`{"operations":` + strconv.FormatInt(count, 10) + `}`), err
		},
		count: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) (int64, error) {
			return q.CountOrderOperations(ctx, account(s))
		},
		outcome: privacy.OutcomeRetainedLegal, note: "Idempotency evidence stays without its actor as part of the financial records.",
	})
	register(privacycatalog.OrganizationContacts, builtin{
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			return q.ExportOrganizationMemberships(ctx, s.PersonID)
		},
		count: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) (int64, error) {
			return q.CountOrganizationMemberships(ctx, s.PersonID)
		},
		outcome: privacy.OutcomeErased,
	})
	register(privacycatalog.MachineJobs, builtin{
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			return q.ExportMachineJobs(ctx, s.PersonID)
		},
		count: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) (int64, error) {
			return q.CountMachineJobs(ctx, s.PersonID)
		},
		outcome: privacy.OutcomeUnlinked, note: "Jobs and runs stay as machine history without the customer or operator; free-text notes are not rewritten.",
	})
	register(privacycatalog.InboxNotifications, builtin{
		account: true,
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			return q.ExportNotifications(ctx, account(s))
		},
		count: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) (int64, error) {
			return q.CountNotifications(ctx, account(s))
		},
		outcome: privacy.OutcomeErased, note: "Deliveries to the account are deleted; the notifications themselves belong to their roles.",
	})
	register(privacycatalog.ActorReferences, builtin{
		account: true,
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			return q.ExportActorReferences(ctx, account(s))
		},
		count:   func(context.Context, *requestsdb.Queries, privacy.DataSubject) (int64, error) { return 0, nil },
		outcome: privacy.OutcomeUnlinked, note: "Records the person acted on stay without the reference to their account.",
	})
	register(privacycatalog.PrivacyRecords, builtin{
		export: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) ([]byte, error) {
			return q.ExportPrivacyRecords(ctx, s.PersonID)
		},
		count: func(ctx context.Context, q *requestsdb.Queries, s privacy.DataSubject) (int64, error) {
			return q.CountPrivacyRecords(ctx, s.PersonID)
		},
		outcome: privacy.OutcomeUnlinked, note: "Holds are deleted with the person; this request stays with its reference and counts only.",
	})
}
