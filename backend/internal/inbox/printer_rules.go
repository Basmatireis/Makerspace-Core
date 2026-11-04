package inbox

import (
	"context"
	"errors"
	"fmt"
	"slices"

	inboxdb "github.com/Basmatireis/Makerspace-Core/backend/internal/inbox/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// PrinterRule is who a printer notification rule reaches: the run's operator, the job's recipient, the people
// holding a role, and whether they get an e-mail as well. MinSeverity only filters printer errors.
type PrinterRule struct {
	NotifyOperator, NotifyRecipient, Email bool
	RoleID                                 *uuid.UUID
	MinSeverity                            *string
}

// defaultPrinterRule applies when a rule row is missing: the operator, in the app only.
var defaultPrinterRule = PrinterRule{NotifyOperator: true}

// printerParties are the people a printer event concerns.
type printerParties struct {
	operator, customerPerson, customerOrganization *uuid.UUID
}

// printerAudience is the resolved recipients of one printer event: accounts for the in-app notification, people and
// organizations for e-mail. Every person appears once, whatever the number of ways the rule reaches them.
type printerAudience struct {
	accounts         []uuid.UUID
	mailPeople       []uuid.UUID
	mailOrganization *uuid.UUID
}

func (e *Emitter) printerRule(ctx context.Context, queries *inboxdb.Queries, kind Kind) (PrinterRule, error) {
	row, err := queries.GetPrinterNotificationRule(ctx, string(kind))
	if errors.Is(err, pgx.ErrNoRows) {
		return defaultPrinterRule, nil
	}
	if err != nil {
		return PrinterRule{}, fmt.Errorf("load %s notification rule: %w", kind, err)
	}
	return PrinterRule{
		NotifyOperator:  row.NotifyOperator,
		NotifyRecipient: row.NotifyRecipient,
		Email:           row.Email,
		RoleID:          row.RoleID,
		MinSeverity:     row.MinSeverity,
	}, nil
}

// resolvePrinterAudience applies a rule. Accounts in excluded (someone who caused the event themselves) and their
// person are left out entirely.
func resolvePrinterAudience(
	ctx context.Context,
	queries *inboxdb.Queries,
	rule PrinterRule,
	parties printerParties,
	excluded []uuid.UUID,
) (printerAudience, error) {
	var people []uuid.UUID
	add := func(id *uuid.UUID) {
		if id != nil && !slices.Contains(people, *id) {
			people = append(people, *id)
		}
	}
	if rule.NotifyOperator {
		add(parties.operator)
	}
	if rule.NotifyRecipient {
		add(parties.customerPerson)
	}
	if rule.RoleID != nil {
		holders, err := queries.ListPersonIDsByRole(ctx, *rule.RoleID)
		if err != nil {
			return printerAudience{}, fmt.Errorf("resolve notification role: %w", err)
		}
		for i := range holders {
			add(&holders[i])
		}
	}
	audience := printerAudience{}
	if len(people) == 0 && (!rule.NotifyRecipient || parties.customerOrganization == nil) {
		return audience, nil
	}
	accounts, err := queries.ListEnabledAccountsOfPeople(ctx, uuidTexts(people))
	if err != nil {
		return printerAudience{}, fmt.Errorf("resolve notification accounts: %w", err)
	}
	skipped := map[uuid.UUID]bool{}
	for _, account := range accounts {
		if slices.Contains(excluded, account.ID) {
			skipped[account.PersonID] = true
		}
	}
	for _, account := range accounts {
		if !skipped[account.PersonID] {
			audience.accounts = append(audience.accounts, account.ID)
		}
	}
	if rule.Email {
		for _, person := range people {
			if !skipped[person] {
				audience.mailPeople = append(audience.mailPeople, person)
			}
		}
		if rule.NotifyRecipient {
			audience.mailOrganization = parties.customerOrganization
		}
	}
	return audience, nil
}

// deliverPrinterEvent writes the in-app notification and queues the e-mails of one printer event.
func (e *Emitter) deliverPrinterEvent(
	ctx context.Context,
	tx pgx.Tx,
	n notice,
	rule PrinterRule,
	parties printerParties,
	excluded []uuid.UUID,
) error {
	queries := inboxdb.New(tx)
	audience, err := resolvePrinterAudience(ctx, queries, rule, parties, excluded)
	if err != nil {
		return err
	}
	if err = e.deliver(ctx, tx, n, audience.accounts); err != nil {
		return err
	}
	return queueNoticeMails(ctx, queries, n, audience.mailPeople, audience.mailOrganization)
}

// queueNoticeMails queues the e-mail of a notification for people and an organization. Mail is only queued while
// mail delivery is switched on; the delivery job sends it after the transaction committed.
func queueNoticeMails(
	ctx context.Context,
	queries *inboxdb.Queries,
	n notice,
	people []uuid.UUID,
	organization *uuid.UUID,
) error {
	if len(people) == 0 && organization == nil {
		return nil
	}
	enabled, err := queries.MailDeliveryEnabled(ctx)
	if err != nil {
		return fmt.Errorf("read mail delivery switch: %w", err)
	}
	if !enabled {
		return nil
	}
	link := n.link
	queue := func(person, organization *uuid.UUID) error {
		return queries.InsertNotificationMail(ctx, inboxdb.InsertNotificationMailParams{
			ID:             ids.New(),
			Kind:           string(n.kind),
			PersonID:       person,
			OrganizationID: organization,
			Subject:        clip(n.title, MaxTitleLength),
			Body:           clip(n.body, MaxBodyLength),
			Link:           &link,
		})
	}
	for i := range people {
		if err = queue(&people[i], nil); err != nil {
			return fmt.Errorf("queue %s mail: %w", n.kind, err)
		}
	}
	if organization != nil {
		if err = queue(nil, organization); err != nil {
			return fmt.Errorf("queue %s mail: %w", n.kind, err)
		}
	}
	return nil
}

// severityAllowed says whether a printer error of severity passes a rule's minimum. Errors without a level (print
// errors, codes of older connectors) always pass, and so does every level without a minimum.
func severityAllowed(severity, minimum *string) bool {
	if severity == nil || minimum == nil {
		return true
	}
	return severityRank(*severity) >= severityRank(*minimum)
}
