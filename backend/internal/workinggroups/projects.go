package workinggroups

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	workinggroupsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
)

const (
	MaxProjectTitleRunes  = 120
	MaxProjectTextRunes   = 1000
	MaxProjectReasonRunes = 500
	MaxProjectReportRunes = 2000
	MaxItemTextRunes      = 160
	MaxItemNoteRunes      = 500
	MaxOfferShopRunes     = 80
	maxProjectPeople      = 100000
)

func pgDate(d pgtype.Date) *time.Time {
	if !d.Valid {
		return nil
	}
	v := time.Date(d.Time.Year(), d.Time.Month(), d.Time.Day(), 0, 0, 0, 0, time.UTC)
	return &v
}

func optionalMoney(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// projectCtx is a project locked for a change, with what the caller is to it.
type projectCtx struct {
	q                                *workinggroupsdb.Queries
	core                             workinggroupsdb.LockWorkingGroupProjectRow
	rules                            workinggroupsdb.GetWorkingGroupFinanceRulesRow
	finance, member, lead, requester bool
}

func (pc *projectCtx) status() string { return pc.core.Status }

// editFields: the lead or the requester while the project is a draft or was returned.
func (pc *projectCtx) editFields() bool {
	return (pc.lead || pc.requester) && (pc.status() == ProjectDraft || pc.status() == ProjectReturned)
}

// editPlan: the cost plan may also be changed by a finance manager until the project is closed.
func (pc *projectCtx) editPlan() bool {
	return pc.editFields() || (pc.finance && pc.status() != ProjectDeclined && pc.status() != ProjectCompleted)
}

func wirefNeeded(paidFrom string, planned, threshold decimal.Decimal) bool {
	return paidFrom == PaidFromExternal || planned.GreaterThanOrEqual(threshold)
}

// lockProject takes the group lock and the project lock and decides what the caller is to the project. Whoever may
// not see it gets 404.
func lockProject(ctx context.Context, tx pgx.Tx, p authorization.Principal, id uuid.UUID) (*projectCtx, error) {
	q := workinggroupsdb.New(tx)
	groupID, err := q.GetWorkingGroupProjectGroup(ctx, id)
	if err != nil {
		return nil, noRows(err)
	}
	if _, err := q.LockWorkingGroup(ctx, groupID); err != nil {
		return nil, noRows(err)
	}
	core, err := q.LockWorkingGroupProject(ctx, id)
	if err != nil {
		return nil, noRows(err)
	}
	member, err := q.IsWorkingGroupMember(ctx, workinggroupsdb.IsWorkingGroupMemberParams{GroupID: groupID, PersonID: p.PersonID})
	if err != nil {
		return nil, err
	}
	finance := isFinance(p)
	if !member && !finance {
		return nil, apperror.NotFound
	}
	lead, err := q.IsWorkingGroupLead(ctx, workinggroupsdb.IsWorkingGroupLeadParams{GroupID: groupID, PersonID: p.PersonID})
	if err != nil {
		return nil, err
	}
	rules, err := q.GetWorkingGroupFinanceRules(ctx)
	if err != nil {
		return nil, err
	}
	return &projectCtx{
		q: q, core: core, rules: rules, finance: finance, member: member, lead: lead,
		requester: core.RequesterPersonID != nil && *core.RequesterPersonID == p.PersonID,
	}, nil
}

func projectStateConflict() error {
	return apperror.Conflicting("working_group_project_state", "The project cannot be changed this way in its current state")
}

// projectChange describes one change of a project: who may do it, in which states, and what it does.
type projectChange struct {
	role   func(pc *projectCtx) bool
	state  func(pc *projectCtx) bool
	change func(tx pgx.Tx, pc *projectCtx) (discard []*uuid.UUID, err error)
	// version is the version the caller saw; 0 skips the optimistic lock.
	version int64
	// keepVersion leaves the version alone (the change bumps it itself).
	keepVersion bool
}

// changeProject runs a change in one transaction. The order of refusals: unknown or invisible (404), not allowed to
// (403), stale version (409 stale_write), wrong state (409). The change and its audit event commit together; replaced
// files are deleted afterwards.
func (s *Service) changeProject(ctx context.Context, p authorization.Principal, id uuid.UUID, c projectChange) error {
	var discard []*uuid.UUID
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		pc, err := lockProject(ctx, tx, p, id)
		if err != nil {
			return err
		}
		if !c.role(pc) {
			return apperror.PermissionDenied
		}
		if c.version != 0 && pc.core.Version != c.version {
			return apperror.StaleWrite
		}
		if !c.state(pc) {
			return projectStateConflict()
		}
		if discard, err = c.change(tx, pc); err != nil {
			return err
		}
		if !c.keepVersion {
			return pc.q.TouchWorkingGroupProject(ctx, id)
		}
		return nil
	})
	if err == nil {
		s.discardFiles(discard...)
	}
	return err
}

func roleFields(pc *projectCtx) bool   { return pc.lead || pc.requester }
func rolePlan(pc *projectCtx) bool     { return pc.lead || pc.requester || pc.finance }
func roleFinanceP(pc *projectCtx) bool { return pc.finance }

func projectIs(statuses ...string) func(pc *projectCtx) bool {
	return func(pc *projectCtx) bool {
		for _, st := range statuses {
			if pc.status() == st {
				return true
			}
		}
		return false
	}
}

func planState(pc *projectCtx) bool { return pc.editPlan() }

func validateProjectFields(in ProjectFields) (ProjectFields, error) {
	out := in
	var err error
	if out.Title, err = validateShortText(in.Title, "title", MaxProjectTitleRunes); err != nil {
		return out, err
	}
	if out.Goal, err = validateText(in.Goal, "goal", MaxProjectTextRunes, false); err != nil {
		return out, err
	}
	if out.Benefit, err = validateText(in.Benefit, "benefit", MaxProjectTextRunes, false); err != nil {
		return out, err
	}
	if in.StartsOn != nil && in.EndsOn != nil && in.EndsOn.Before(*in.StartsOn) {
		return out, apperror.InvalidField("endsOn")
	}
	if in.People < 1 || in.People > maxProjectPeople {
		return out, apperror.InvalidField("people")
	}
	income, err := parseMoney(in.PlannedIncome, "plannedIncome")
	if err != nil {
		return out, err
	}
	out.PlannedIncome = moneyText(income)
	out.AdvanceAmount = nil
	if in.AdvanceAmount != nil {
		amount, err := parseMoney(*in.AdvanceAmount, "advanceAmount")
		if err != nil {
			return out, err
		}
		text := moneyText(amount)
		out.AdvanceAmount = &text
	}
	return out, nil
}

func validateLink(in *string) (*string, error) {
	if in == nil {
		return nil, nil
	}
	clean := strings.TrimSpace(*in)
	if clean == "" {
		return nil, nil
	}
	parsed, err := url.Parse(clean)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || utf8.RuneCountInString(clean) > MaxPurchaseLinkRunes {
		return nil, apperror.InvalidField("link")
	}
	return &clean, nil
}

func validateProjectItem(in ProjectItemInput) (string, decimal.Decimal, *string, *string, error) {
	text, err := validateShortText(in.Text, "text", MaxItemTextRunes)
	if err != nil {
		return "", decimal.Zero, nil, nil, err
	}
	amount, err := parseMoney(in.PlannedAmount, "plannedAmount")
	if err != nil {
		return "", decimal.Zero, nil, nil, err
	}
	link, err := validateLink(in.Link)
	if err != nil {
		return "", decimal.Zero, nil, nil, err
	}
	var note *string
	if in.Note != nil {
		clean, err := validateText(*in.Note, "note", MaxItemNoteRunes, false)
		if err != nil {
			return "", decimal.Zero, nil, nil, err
		}
		if clean != "" {
			note = &clean
		}
	}
	return text, amount, link, note, nil
}

// checklistOf decides what is still open before the hand-in.
func checklistOf(goal, benefit string, items []ProjectItem) ProjectChecklist {
	open := []string{}
	if strings.TrimSpace(goal) == "" {
		open = append(open, "goal_missing")
	}
	if strings.TrimSpace(benefit) == "" {
		open = append(open, "benefit_missing")
	}
	if len(items) == 0 {
		open = append(open, "items_missing")
	}
	for _, item := range items {
		if item.NeedsOffers {
			if len(item.Offers) < MinOffersForThreshold {
				open = append(open, "item_needs_offers:"+item.ID.String())
			}
			continue
		}
		ok := false
		for _, pu := range item.Purchases {
			if pu.Status != PurchaseDeclined && ((pu.Link != nil && *pu.Link != "") || pu.HasAttachment) {
				ok = true
			}
		}
		if !ok {
			open = append(open, "item_needs_purchase:"+item.ID.String())
		}
	}
	return ProjectChecklist{Complete: len(open) == 0, Open: open}
}

func (s *Service) projectFromRow(
	ctx context.Context,
	q *workinggroupsdb.Queries,
	p authorization.Principal,
	row workinggroupsdb.ListWorkingGroupProjectsRow,
	rules workinggroupsdb.GetWorkingGroupFinanceRulesRow,
	full bool,
) (Project, error) {
	finance := isFinance(p)
	requester := row.RequesterPersonID != nil && *row.RequesterPersonID == p.PersonID
	planned := dbMoney(row.PlannedTotal)
	paidFrom := row.PaidFrom
	needed := wirefNeeded(paidFrom, planned, dbMoney(rules.ProjectThreshold))
	editFields := (row.CallerIsLead || requester) && (row.Status == ProjectDraft || row.Status == ProjectReturned)
	project := Project{
		ID: row.ID, GroupID: row.GroupID, GroupName: row.GroupName, Title: row.Title, Goal: row.Goal, Benefit: row.Benefit,
		StartsOn: pgDate(row.StartsOn), EndsOn: pgDate(row.EndsOn), People: row.People, PlannedIncome: moneyText(dbMoney(row.PlannedIncome)),
		Alcohol: row.Alcohol, AdvanceRequested: row.AdvanceRequested, WiRefNumber: row.WirefNumber, Status: row.Status,
		Requester: personRef(row.RequesterPersonID, row.RequesterDisplayName), CompletionReport: row.CompletionReport,
		WiRefNeeded: needed, HasRequestPDF: row.HasRequestPdf, CreatedAt: row.CreatedAt, Version: row.Version,
		WiRefRequestPending: (row.Status == ProjectRunning || row.Status == ProjectWiRef) && needed && !row.WirefRequestSentAt.Valid,
		CanEdit:             editFields || (finance && row.Status != ProjectDeclined && row.Status != ProjectCompleted),
		CanSubmit:           editFields,
		CanDecide:           finance && (row.Status == ProjectSubmitted || row.Status == ProjectWiRef),
		CanComplete:         (row.CallerIsLead || finance) && row.Status == ProjectRunning,
		Items:               []ProjectItem{}, History: []ProjectHistoryEntry{},
		Totals: ProjectTotals{
			Planned: moneyText(planned), InPurchases: moneyText(dbMoney(row.InPurchases)), Spent: moneyText(dbMoney(row.Spent)),
			Left: moneyText(decimal.Max(decimal.Zero, planned.Sub(dbMoney(row.Counted)))),
		},
	}
	if paidFrom != "" {
		project.PaidFrom = &paidFrom
	}
	if row.AdvanceRequested {
		amount := moneyText(planned)
		if row.AdvanceAmount != "" {
			amount = moneyText(dbMoney(row.AdvanceAmount))
		}
		project.AdvanceAmount = &amount
	}
	if row.AdvanceStatus != "" {
		status := row.AdvanceStatus
		project.AdvanceStatus = &status
	}
	if finance && row.RequestForm != "" {
		var form RequestForm
		if json.Unmarshal([]byte(row.RequestForm), &form) == nil {
			project.RequestForm = &form
		}
	}
	if !full {
		return project, nil
	}
	items, err := q.ListWorkingGroupProjectItems(ctx, row.ID)
	if err != nil {
		return Project{}, err
	}
	offers, err := q.ListWorkingGroupProjectOffers(ctx, row.ID)
	if err != nil {
		return Project{}, err
	}
	purchases, err := q.ListWorkingGroupProjectPurchases(ctx, &row.ID)
	if err != nil {
		return Project{}, err
	}
	offersThreshold := dbMoney(rules.OffersThreshold)
	for _, it := range items {
		item := ProjectItem{
			ID: it.ID, Position: it.Position, Text: it.Text, PlannedAmount: moneyText(dbMoney(it.PlannedAmount)),
			Link: optionalMoney(it.Link), Note: optionalMoney(it.Note), ChosenOfferID: it.ChosenOfferID,
			NeedsOffers: dbMoney(it.PlannedAmount).GreaterThanOrEqual(offersThreshold),
			Offers:      []ProjectOffer{}, Purchases: []ProjectPurchase{},
		}
		for _, o := range offers {
			if o.ItemID == it.ID {
				item.Offers = append(item.Offers, ProjectOffer{ID: o.ID, Shop: o.Shop, Price: moneyText(dbMoney(o.Price)), HasFile: o.HasFile})
			}
		}
		for _, pu := range purchases {
			if pu.ProjectItemID != nil && *pu.ProjectItemID == it.ID {
				item.Purchases = append(item.Purchases, ProjectPurchase{
					ID: pu.ID, ItemID: pu.ProjectItemID, Item: pu.Item, Link: optionalMoney(pu.Link), Quantity: pu.Quantity,
					UnitPrice: moneyText(dbMoney(pu.UnitPrice)), Status: pu.Status, HasAttachment: pu.HasAttachment,
				})
			}
		}
		project.Items = append(project.Items, item)
	}
	project.Checklist = checklistOf(row.Goal, row.Benefit, project.Items)
	history, err := q.ListWorkingGroupProjectHistory(ctx, row.ID)
	if err != nil {
		return Project{}, err
	}
	for _, h := range history {
		project.History = append(project.History, ProjectHistoryEntry{
			Status: h.Status, Actor: personRef(h.ActorPersonID, h.ActorDisplayName), Reason: h.Reason, At: h.CreatedAt,
		})
	}
	return project, nil
}

func (s *Service) queryProjects(
	ctx context.Context,
	q *workinggroupsdb.Queries,
	p authorization.Principal,
	filter ProjectFilter,
	id *uuid.UUID,
	limit int32,
	full bool,
) ([]Project, error) {
	rules, err := q.GetWorkingGroupFinanceRules(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := q.ListWorkingGroupProjects(ctx, workinggroupsdb.ListWorkingGroupProjectsParams{
		CallerFinance: isFinance(p), CallerPersonID: p.PersonID, ProjectID: id, GroupID: filter.GroupID, Status: filter.Status, RowLimit: limit,
	})
	if err != nil {
		return nil, err
	}
	out := make([]Project, 0, len(rows))
	for _, row := range rows {
		project, err := s.projectFromRow(ctx, q, p, row, rules, full)
		if err != nil {
			return nil, err
		}
		out = append(out, project)
	}
	return out, nil
}

func (s *Service) loadProject(ctx context.Context, q *workinggroupsdb.Queries, p authorization.Principal, id uuid.UUID) (Project, error) {
	items, err := s.queryProjects(ctx, q, p, ProjectFilter{}, &id, 1, true)
	if err != nil {
		return Project{}, err
	}
	if len(items) == 0 {
		return Project{}, apperror.NotFound
	}
	return items[0], nil
}

func validProjectStatus(value string) bool {
	switch value {
	case ProjectDraft, ProjectSubmitted, ProjectReturned, ProjectDeclined, ProjectWiRef, ProjectRunning, ProjectCompleted:
		return true
	}
	return false
}

// ListProjects lists the projects the caller may see, newest first, without their items; truncated tells when more
// matched.
func (s *Service) ListProjects(ctx context.Context, p authorization.Principal, filter ProjectFilter) ([]Project, bool, error) {
	if err := requireRead(p); err != nil {
		return nil, false, err
	}
	if filter.Status != nil && !validProjectStatus(*filter.Status) {
		return nil, false, apperror.InvalidField("status")
	}
	items, err := s.queryProjects(ctx, workinggroupsdb.New(s.pool), p, filter, nil, MaxProjectListRows+1, false)
	if err != nil {
		return nil, false, err
	}
	truncated := len(items) > MaxProjectListRows
	if truncated {
		items = items[:MaxProjectListRows]
	}
	return items, truncated, nil
}

// GetProject returns one project; for people who may not see it, it does not exist.
func (s *Service) GetProject(ctx context.Context, p authorization.Principal, id uuid.UUID) (Project, error) {
	if err := requireRead(p); err != nil {
		return Project{}, err
	}
	return s.loadProject(ctx, workinggroupsdb.New(s.pool), p, id)
}

func addProjectHistory(ctx context.Context, q *workinggroupsdb.Queries, p authorization.Principal, id uuid.UUID, status, reason string) error {
	person := p.PersonID
	var text *string
	if reason != "" {
		text = &reason
	}
	return q.AddWorkingGroupProjectHistory(ctx, workinggroupsdb.AddWorkingGroupProjectHistoryParams{
		ID: ids.New(), ProjectID: id, Status: status, ActorPersonID: &person, Reason: text,
	})
}

// CreateProject starts a draft. Only members of the group may; a finance manager who is not a member is refused
// (403), anybody else does not see the group (404).
func (s *Service) CreateProject(
	ctx context.Context,
	p authorization.Principal,
	input CreateProjectInput,
	requestID *uuid.UUID,
) (result Project, err error) {
	if err := requireRead(p); err != nil {
		return Project{}, err
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		if _, err := q.LockWorkingGroup(ctx, input.GroupID); err != nil {
			return noRows(err)
		}
		member, err := q.IsWorkingGroupMember(ctx, workinggroupsdb.IsWorkingGroupMemberParams{GroupID: input.GroupID, PersonID: p.PersonID})
		if err != nil {
			return err
		}
		if !member {
			if isFinance(p) {
				return apperror.PermissionDenied
			}
			return apperror.NotFound
		}
		fields, err := validateProjectFields(input.ProjectFields)
		if err != nil {
			return err
		}
		id := ids.New()
		person := p.PersonID
		if err := q.CreateWorkingGroupProject(ctx, workinggroupsdb.CreateWorkingGroupProjectParams{
			ID: id, GroupID: input.GroupID, Title: fields.Title, Goal: fields.Goal, Benefit: fields.Benefit,
			StartsOn: dateParam(fields.StartsOn), EndsOn: dateParam(fields.EndsOn), People: int32(fields.People),
			PlannedIncome: fields.PlannedIncome, Alcohol: fields.Alcohol, AdvanceRequested: fields.AdvanceRequested,
			AdvanceAmount: fields.AdvanceAmount, RequesterPersonID: &person,
		}); err != nil {
			return err
		}
		if err := addProjectHistory(ctx, q, p, id, ProjectDraft, ""); err != nil {
			return err
		}
		if err := writeTaskAudit(ctx, tx, p, "working_group_project.created", "working_group_project", id, requestID,
			[]string{"groupId", "title", "goal", "benefit", "startsOn", "endsOn", "people", "plannedIncome", "alcohol", "advance"}); err != nil {
			return err
		}
		result, err = s.loadProject(ctx, q, p, id)
		return err
	})
	return result, err
}

func (s *Service) reloaded(ctx context.Context, p authorization.Principal, id uuid.UUID) (Project, error) {
	return s.loadProject(ctx, workinggroupsdb.New(s.pool), p, id)
}

// UpdateProject replaces the editable fields.
func (s *Service) UpdateProject(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input UpdateProjectInput,
	requestID *uuid.UUID,
) (Project, error) {
	if err := requireRead(p); err != nil {
		return Project{}, err
	}
	if input.ExpectedVersion < 1 {
		return Project{}, apperror.Invalid("expectedVersion must be positive")
	}
	err := s.changeProject(ctx, p, id, projectChange{
		role: roleFields, state: func(pc *projectCtx) bool { return pc.editFields() }, version: input.ExpectedVersion, keepVersion: true,
		change: func(tx pgx.Tx, pc *projectCtx) ([]*uuid.UUID, error) {
			fields, err := validateProjectFields(input.ProjectFields)
			if err != nil {
				return nil, err
			}
			if err := pc.q.UpdateWorkingGroupProject(ctx, workinggroupsdb.UpdateWorkingGroupProjectParams{
				ID: id, Title: fields.Title, Goal: fields.Goal, Benefit: fields.Benefit, StartsOn: dateParam(fields.StartsOn),
				EndsOn: dateParam(fields.EndsOn), People: int32(fields.People), PlannedIncome: fields.PlannedIncome,
				Alcohol: fields.Alcohol, AdvanceRequested: fields.AdvanceRequested, AdvanceAmount: fields.AdvanceAmount,
			}); err != nil {
				return nil, err
			}
			return nil, writeTaskAudit(ctx, tx, p, "working_group_project.updated", "working_group_project", id, requestID,
				[]string{"title", "goal", "benefit", "startsOn", "endsOn", "people", "plannedIncome", "alcohol", "advance"})
		},
	})
	if err != nil {
		return Project{}, err
	}
	return s.reloaded(ctx, p, id)
}

// DeleteProject deletes a draft, returned or declined project with its planned purchases and files: the lead, the
// requester or a finance manager.
func (s *Service) DeleteProject(ctx context.Context, p authorization.Principal, id uuid.UUID, requestID *uuid.UUID) error {
	if err := requireRead(p); err != nil {
		return err
	}
	return s.changeProject(ctx, p, id, projectChange{
		role: rolePlan, keepVersion: true,
		state: func(pc *projectCtx) bool {
			return pc.status() == ProjectDeclined || ((pc.lead || pc.requester || pc.finance) &&
				(pc.status() == ProjectDraft || pc.status() == ProjectReturned))
		},
		change: func(tx pgx.Tx, pc *projectCtx) ([]*uuid.UUID, error) {
			var discard []*uuid.UUID
			attachments, err := pc.q.ListWorkingGroupProjectPurchaseFileIDs(ctx, &id)
			if err != nil {
				return nil, err
			}
			offerFiles, err := pc.q.ListWorkingGroupProjectOfferFileIDs(ctx, id)
			if err != nil {
				return nil, err
			}
			discard = append(discard, attachments...)
			discard = append(discard, offerFiles...)
			discard = append(discard, pc.core.RequestSignatureFileID, pc.core.RequestPdfFileID)
			if err := pc.q.DeleteWorkingGroupProjectPlannedPurchases(ctx, &id); err != nil {
				return nil, err
			}
			if err := pc.q.DeleteWorkingGroupProject(ctx, id); err != nil {
				return nil, err
			}
			return discard, writeTaskAudit(ctx, tx, p, "working_group_project.deleted", "working_group_project", id, requestID, []string{"groupId"})
		},
	})
}

// CreateProjectItem adds a line to the cost plan.
func (s *Service) CreateProjectItem(
	ctx context.Context,
	p authorization.Principal,
	projectID uuid.UUID,
	input ProjectItemInput,
	requestID *uuid.UUID,
) (Project, error) {
	if err := requireRead(p); err != nil {
		return Project{}, err
	}
	err := s.changeProject(ctx, p, projectID, projectChange{
		role: rolePlan, state: planState,
		change: func(tx pgx.Tx, pc *projectCtx) ([]*uuid.UUID, error) {
			text, amount, link, note, err := validateProjectItem(input)
			if err != nil {
				return nil, err
			}
			count, err := pc.q.CountWorkingGroupProjectItems(ctx, projectID)
			if err != nil {
				return nil, err
			}
			if count >= MaxProjectItems {
				return nil, apperror.Invalid("a project has at most 100 items")
			}
			id := ids.New()
			if err := pc.q.CreateWorkingGroupProjectItem(ctx, workinggroupsdb.CreateWorkingGroupProjectItemParams{
				ID: id, ProjectID: projectID, Text: text, PlannedAmount: moneyText(amount), Link: link, Note: note,
			}); err != nil {
				return nil, err
			}
			return nil, writeTaskAudit(ctx, tx, p, "working_group_project_item.created", "working_group_project", projectID, requestID,
				[]string{"itemId", "text", "plannedAmount", "link", "note"})
		},
	})
	if err != nil {
		return Project{}, err
	}
	return s.reloaded(ctx, p, projectID)
}

// itemOfProject checks that an item belongs to the (locked) project.
func itemOfProject(ctx context.Context, pc *projectCtx, projectID, itemID uuid.UUID) (workinggroupsdb.LockWorkingGroupProjectItemRow, error) {
	item, err := pc.q.LockWorkingGroupProjectItem(ctx, itemID)
	if err != nil {
		return item, noRows(err)
	}
	if item.ProjectID != projectID {
		return item, apperror.NotFound
	}
	return item, nil
}

// UpdateProjectItem changes a line of the cost plan. An item whose offer was chosen keeps that offer's price.
func (s *Service) UpdateProjectItem(
	ctx context.Context,
	p authorization.Principal,
	projectID, itemID uuid.UUID,
	input ProjectItemInput,
	requestID *uuid.UUID,
) (Project, error) {
	if err := requireRead(p); err != nil {
		return Project{}, err
	}
	err := s.changeProject(ctx, p, projectID, projectChange{
		role: rolePlan, state: planState, version: input.ExpectedVersion,
		change: func(tx pgx.Tx, pc *projectCtx) ([]*uuid.UUID, error) {
			item, err := itemOfProject(ctx, pc, projectID, itemID)
			if err != nil {
				return nil, err
			}
			text, amount, link, note, err := validateProjectItem(input)
			if err != nil {
				return nil, err
			}
			if item.ChosenOfferID != nil {
				amount = dbMoney(item.PlannedAmount)
			}
			if err := pc.q.UpdateWorkingGroupProjectItem(ctx, workinggroupsdb.UpdateWorkingGroupProjectItemParams{
				ID: itemID, Text: text, PlannedAmount: moneyText(amount), Link: link, Note: note,
			}); err != nil {
				return nil, err
			}
			return nil, writeTaskAudit(ctx, tx, p, "working_group_project_item.updated", "working_group_project", projectID, requestID,
				[]string{"itemId", "text", "plannedAmount", "link", "note"})
		},
	})
	if err != nil {
		return Project{}, err
	}
	return s.reloaded(ctx, p, projectID)
}

// DeleteProjectItem removes a line with its offers and their files.
func (s *Service) DeleteProjectItem(
	ctx context.Context,
	p authorization.Principal,
	projectID, itemID uuid.UUID,
	requestID *uuid.UUID,
) (Project, error) {
	if err := requireRead(p); err != nil {
		return Project{}, err
	}
	err := s.changeProject(ctx, p, projectID, projectChange{
		role: rolePlan, state: planState,
		change: func(tx pgx.Tx, pc *projectCtx) ([]*uuid.UUID, error) {
			if _, err := itemOfProject(ctx, pc, projectID, itemID); err != nil {
				return nil, err
			}
			fileIDs, err := pc.q.ListWorkingGroupProjectItemFileIDs(ctx, itemID)
			if err != nil {
				return nil, err
			}
			if err := pc.q.DeleteWorkingGroupProjectItem(ctx, itemID); err != nil {
				return nil, err
			}
			discard := append([]*uuid.UUID(nil), fileIDs...)
			return discard, writeTaskAudit(ctx, tx, p, "working_group_project_item.deleted", "working_group_project", projectID, requestID, []string{"itemId"})
		},
	})
	if err != nil {
		return Project{}, err
	}
	return s.reloaded(ctx, p, projectID)
}

// ReorderProjectItems sets the order of the items; itemIDs must list every item once.
func (s *Service) ReorderProjectItems(
	ctx context.Context,
	p authorization.Principal,
	projectID uuid.UUID,
	expected int64,
	itemIDs []uuid.UUID,
	requestID *uuid.UUID,
) (Project, error) {
	if err := requireRead(p); err != nil {
		return Project{}, err
	}
	err := s.changeProject(ctx, p, projectID, projectChange{
		role: rolePlan, state: planState, version: expected,
		change: func(tx pgx.Tx, pc *projectCtx) ([]*uuid.UUID, error) {
			current, err := pc.q.ListWorkingGroupProjectItems(ctx, projectID)
			if err != nil {
				return nil, err
			}
			known := map[uuid.UUID]bool{}
			for _, it := range current {
				known[it.ID] = true
			}
			if len(itemIDs) != len(current) {
				return nil, apperror.InvalidField("itemIds")
			}
			for position, id := range itemIDs {
				if !known[id] {
					return nil, apperror.InvalidField("itemIds")
				}
				delete(known, id)
				if err := pc.q.SetWorkingGroupProjectItemPosition(ctx, workinggroupsdb.SetWorkingGroupProjectItemPositionParams{
					ID: id, ProjectID: projectID, Position: int32(position),
				}); err != nil {
					return nil, err
				}
			}
			return nil, writeTaskAudit(ctx, tx, p, "working_group_project_item.reordered", "working_group_project", projectID, requestID, []string{"order"})
		},
	})
	if err != nil {
		return Project{}, err
	}
	return s.reloaded(ctx, p, projectID)
}

// CreateProjectOffer adds an offer to an item (at most ten).
func (s *Service) CreateProjectOffer(
	ctx context.Context,
	p authorization.Principal,
	projectID, itemID uuid.UUID,
	input ProjectOfferInput,
	requestID *uuid.UUID,
) (Project, error) {
	if err := requireRead(p); err != nil {
		return Project{}, err
	}
	err := s.changeProject(ctx, p, projectID, projectChange{
		role: rolePlan, state: planState, version: input.ExpectedVersion,
		change: func(tx pgx.Tx, pc *projectCtx) ([]*uuid.UUID, error) {
			if _, err := itemOfProject(ctx, pc, projectID, itemID); err != nil {
				return nil, err
			}
			shop, err := validateShortText(input.Shop, "shop", MaxOfferShopRunes)
			if err != nil {
				return nil, err
			}
			price, err := parseMoney(input.Price, "price")
			if err != nil {
				return nil, err
			}
			count, err := pc.q.CountWorkingGroupProjectOffers(ctx, itemID)
			if err != nil {
				return nil, err
			}
			if count >= MaxOffersPerItem {
				return nil, apperror.Invalid("an item has at most 10 offers")
			}
			id := ids.New()
			if err := pc.q.CreateWorkingGroupProjectOffer(ctx, workinggroupsdb.CreateWorkingGroupProjectOfferParams{
				ID: id, ItemID: itemID, Shop: shop, Price: moneyText(price),
			}); err != nil {
				return nil, err
			}
			return nil, writeTaskAudit(ctx, tx, p, "working_group_project_offer.created", "working_group_project", projectID, requestID,
				[]string{"itemId", "offerId", "shop", "price"})
		},
	})
	if err != nil {
		return Project{}, err
	}
	return s.reloaded(ctx, p, projectID)
}

// DeleteProjectOffer removes an offer and its file; an item that had chosen it loses the choice.
func (s *Service) DeleteProjectOffer(
	ctx context.Context,
	p authorization.Principal,
	projectID, offerID uuid.UUID,
	requestID *uuid.UUID,
) (Project, error) {
	if err := requireRead(p); err != nil {
		return Project{}, err
	}
	err := s.changeProject(ctx, p, projectID, projectChange{
		role: rolePlan, state: planState,
		change: func(tx pgx.Tx, pc *projectCtx) ([]*uuid.UUID, error) {
			offer, err := offerOfProject(ctx, pc, projectID, offerID)
			if err != nil {
				return nil, err
			}
			if err := pc.q.DeleteWorkingGroupProjectOffer(ctx, offerID); err != nil {
				return nil, err
			}
			return []*uuid.UUID{offer.FileID}, writeTaskAudit(ctx, tx, p, "working_group_project_offer.deleted", "working_group_project", projectID, requestID, []string{"offerId"})
		},
	})
	if err != nil {
		return Project{}, err
	}
	return s.reloaded(ctx, p, projectID)
}

func offerOfProject(ctx context.Context, pc *projectCtx, projectID, offerID uuid.UUID) (workinggroupsdb.GetWorkingGroupProjectOfferRow, error) {
	owner, err := pc.q.GetWorkingGroupProjectOfferProject(ctx, offerID)
	if err != nil {
		return workinggroupsdb.GetWorkingGroupProjectOfferRow{}, noRows(err)
	}
	if owner.ProjectID != projectID {
		return workinggroupsdb.GetWorkingGroupProjectOfferRow{}, apperror.NotFound
	}
	offer, err := pc.q.GetWorkingGroupProjectOffer(ctx, offerID)
	return offer, noRows(err)
}

// precheckProject refuses, before a file is stored, a caller who may not see the project (404) or may not do the
// operation (403). The real decision is taken again under the locks.
func (s *Service) precheckProject(ctx context.Context, p authorization.Principal, id uuid.UUID, allowed func(pc *projectCtx) bool) error {
	q := workinggroupsdb.New(s.pool)
	rows, err := q.ListWorkingGroupProjects(ctx, workinggroupsdb.ListWorkingGroupProjectsParams{
		CallerFinance: isFinance(p), CallerPersonID: p.PersonID, ProjectID: &id, RowLimit: 1,
	})
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return apperror.NotFound
	}
	pc := &projectCtx{
		finance: isFinance(p), member: rows[0].CallerIsMember, lead: rows[0].CallerIsLead,
		requester: rows[0].RequesterPersonID != nil && *rows[0].RequesterPersonID == p.PersonID,
	}
	if !allowed(pc) {
		return apperror.PermissionDenied
	}
	return nil
}

// CheckProjectOfferUpload is the refusal an upload handler runs before it reads the body.
func (s *Service) CheckProjectOfferUpload(ctx context.Context, p authorization.Principal, projectID uuid.UUID) error {
	if err := requireRead(p); err != nil {
		return err
	}
	return s.precheckProject(ctx, p, projectID, rolePlan)
}

// SetProjectOfferFile attaches the offer's file, replacing an earlier one.
func (s *Service) SetProjectOfferFile(
	ctx context.Context,
	p authorization.Principal,
	projectID, offerID uuid.UUID,
	upload FileUpload,
	requestID *uuid.UUID,
) (Project, error) {
	if err := requireRead(p); err != nil {
		return Project{}, err
	}
	if err := s.precheckProject(ctx, p, projectID, rolePlan); err != nil {
		return Project{}, err
	}
	stored, err := s.storeFile(ctx, p, upload, requestID)
	if err != nil {
		return Project{}, err
	}
	err = s.changeProject(ctx, p, projectID, projectChange{
		role: rolePlan, state: planState,
		change: func(tx pgx.Tx, pc *projectCtx) ([]*uuid.UUID, error) {
			offer, err := offerOfProject(ctx, pc, projectID, offerID)
			if err != nil {
				return nil, err
			}
			fileID := stored.ID
			params := workinggroupsdb.SetWorkingGroupProjectOfferFileParams{ID: offerID, FileID: &fileID}
			if err := pc.q.SetWorkingGroupProjectOfferFile(ctx, params); err != nil {
				return nil, err
			}
			return []*uuid.UUID{offer.FileID}, writeTaskAudit(ctx, tx, p, "working_group_project_offer.file_set", "working_group_project", projectID, requestID,
				[]string{"offerId", "file"})
		},
	})
	if err != nil {
		s.discardFiles(&stored.ID)
		return Project{}, err
	}
	return s.reloaded(ctx, p, projectID)
}

// OpenProjectOfferFile opens the file of an offer for whoever may see the project.
func (s *Service) OpenProjectOfferFile(
	ctx context.Context,
	p authorization.Principal,
	projectID,
	offerID uuid.UUID,
) (files.File, io.ReadCloser, error) {
	if err := requireRead(p); err != nil {
		return files.File{}, nil, err
	}
	q := workinggroupsdb.New(s.pool)
	if _, err := s.loadProject(ctx, q, p, projectID); err != nil {
		return files.File{}, nil, err
	}
	owner, err := q.GetWorkingGroupProjectOfferProject(ctx, offerID)
	if err != nil || owner.ProjectID != projectID {
		return files.File{}, nil, apperror.NotFound
	}
	offer, err := q.GetWorkingGroupProjectOffer(ctx, offerID)
	if err != nil {
		return files.File{}, nil, noRows(err)
	}
	return s.openFile(ctx, offer.FileID)
}

// projectForNewPurchases checks the project a purchase request refers to (under the group lock) and tells whether
// the purchases are planned ones.
func projectForNewPurchases(ctx context.Context, q *workinggroupsdb.Queries, input CreatePurchasesInput) (bool, error) {
	if input.ProjectID == nil {
		if input.ProjectItemID != nil {
			return false, apperror.InvalidField("projectItemId")
		}
		return false, nil
	}
	groupID, err := q.GetWorkingGroupProjectGroup(ctx, *input.ProjectID)
	if err != nil || groupID != input.GroupID {
		return false, apperror.InvalidField("projectId")
	}
	core, err := q.LockWorkingGroupProject(ctx, *input.ProjectID)
	if err != nil {
		return false, apperror.InvalidField("projectId")
	}
	if input.ProjectItemID != nil {
		owner, err := q.GetWorkingGroupProjectItemProject(ctx, *input.ProjectItemID)
		if err != nil || owner != *input.ProjectID {
			return false, apperror.InvalidField("projectItemId")
		}
	}
	switch core.Status {
	case ProjectDraft, ProjectReturned, ProjectSubmitted, ProjectWiRef:
		return true, nil
	case ProjectRunning:
		return false, nil
	}
	return false, projectStateConflict()
}

// ConvertPurchaseToProject turns a wanted purchase into a draft project with one item and links the purchase to it
// as a planned purchase. The lead of the group or the requester of the purchase may.
func (s *Service) ConvertPurchaseToProject(
	ctx context.Context,
	p authorization.Principal,
	purchaseID uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) (result Project, err error) {
	if err := requireRead(p); err != nil {
		return Project{}, err
	}
	if expected < 1 {
		return Project{}, apperror.Invalid("expectedVersion must be positive")
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		pc, err := lockPurchase(ctx, tx, p, purchaseID)
		if err != nil {
			return err
		}
		if !pc.access.lead && !pc.access.requester {
			return apperror.PermissionDenied
		}
		if pc.core.Version != expected {
			return apperror.StaleWrite
		}
		if pc.closed {
			return periodClosedError()
		}
		if pc.core.Status != PurchaseWanted || pc.core.ProjectID != nil {
			return purchaseStateConflict()
		}
		row, err := pc.q.GetWorkingGroupPurchaseForProject(ctx, purchaseID)
		if err != nil {
			return err
		}
		id, itemID := ids.New(), ids.New()
		person := p.PersonID
		title := row.Item
		if utf8.RuneCountInString(title) > MaxProjectTitleRunes {
			title = string([]rune(title)[:MaxProjectTitleRunes])
		}
		if err := pc.q.CreateWorkingGroupProject(ctx, workinggroupsdb.CreateWorkingGroupProjectParams{
			ID: id, GroupID: row.GroupID, Title: title, People: 1, PlannedIncome: "0.00", RequesterPersonID: &person,
		}); err != nil {
			return err
		}
		if err := pc.q.CreateWorkingGroupProjectItem(ctx, workinggroupsdb.CreateWorkingGroupProjectItemParams{
			ID: itemID, ProjectID: id, Text: row.Item, PlannedAmount: moneyText(dbMoney(row.Total)), Link: optionalMoney(row.Link),
		}); err != nil {
			return err
		}
		if err := pc.q.LinkWorkingGroupPurchaseToProject(ctx, workinggroupsdb.LinkWorkingGroupPurchaseToProjectParams{
			ID: purchaseID, ProjectID: &id, ProjectItemID: &itemID,
		}); err != nil {
			return err
		}
		if err := addProjectHistory(ctx, pc.q, p, id, ProjectDraft, ""); err != nil {
			return err
		}
		if err := writeTaskAudit(ctx, tx, p, "working_group_project.created", "working_group_project", id, requestID,
			[]string{"groupId", "title", "purchaseId"}); err != nil {
			return err
		}
		result, err = s.loadProject(ctx, pc.q, p, id)
		return err
	})
	return result, err
}

var errNoPeriod = apperror.New(http.StatusUnprocessableEntity, "budget_period_missing", "There is no open budget period for today")
