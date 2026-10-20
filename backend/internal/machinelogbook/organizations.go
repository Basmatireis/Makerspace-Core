package machinelogbook

import (
	"context"
	"errors"
	"net/mail"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func organizationFromRow(row machinelogbookdb.Organization) Organization {
	return Organization{
		ID:     row.ID,
		Name:   row.Name,
		Kind:   OrganizationKind(row.Kind),
		Active: row.Active,
		OrganizationDetails: OrganizationDetails{
			AddressLine:  row.AddressLine,
			PostalCode:   row.PostalCode,
			Locality:     row.Locality,
			CountryCode:  row.CountryCode,
			ContactName:  row.ContactName,
			ContactEmail: row.ContactEmail,
		},
		Version:   row.Version,
		CreatedAt: row.CreatedAt,
		UpdatedAt: row.UpdatedAt,
	}
}
func validateOrganizationKind(kind OrganizationKind) error {
	if kind != OrganizationCompany && kind != OrganizationInstitute && kind != OrganizationAssociation && kind != OrganizationOther {
		return apperror.Invalid("invalid organization kind")
	}
	return nil
}

// mergeOrganizationDetails applies the supplied changes to the current values,
// trims them, and validates length, country code and email shape.
func mergeOrganizationDetails(current OrganizationDetails, in OrganizationDetailsInput) (OrganizationDetails, error) {
	apply := func(target *string, value *string, field string, max int) error {
		if value == nil {
			return nil
		}
		v := strings.TrimSpace(*value)
		if len([]rune(v)) > max {
			return apperror.Invalid(field + " is too long")
		}
		*target = v
		return nil
	}
	out := current
	for _, f := range []struct {
		target *string
		value  *string
		field  string
		max    int
	}{
		{&out.AddressLine, in.AddressLine, "addressLine", 200},
		{&out.PostalCode, in.PostalCode, "postalCode", 20},
		{&out.Locality, in.Locality, "locality", 100},
		{&out.ContactName, in.ContactName, "contactName", 200},
		{&out.ContactEmail, in.ContactEmail, "contactEmail", 254},
	} {
		if err := apply(f.target, f.value, f.field, f.max); err != nil {
			return OrganizationDetails{}, err
		}
	}
	if in.CountryCode != nil {
		code := strings.ToUpper(strings.TrimSpace(*in.CountryCode))
		if code != "" && (len(code) != 2 || code[0] < 'A' || code[0] > 'Z' || code[1] < 'A' || code[1] > 'Z') {
			return OrganizationDetails{}, apperror.Invalid("countryCode must be a two-letter ISO 3166-1 code")
		}
		out.CountryCode = code
	}
	if out.ContactEmail != "" {
		addr, err := mail.ParseAddress(out.ContactEmail)
		if err != nil || addr.Address != out.ContactEmail || addr.Name != "" {
			return OrganizationDetails{}, apperror.Invalid("contactEmail must be a plain email address")
		}
	}
	return out, nil
}

func changedOrganizationDetailFields(in OrganizationDetailsInput) []string {
	var fields []string
	for _, f := range []struct {
		name  string
		value *string
	}{{"addressLine", in.AddressLine}, {"postalCode", in.PostalCode}, {"locality", in.Locality}, {"countryCode", in.CountryCode}, {"contactName", in.ContactName}, {"contactEmail", in.ContactEmail}} {
		if f.value != nil {
			fields = append(fields, f.name)
		}
	}
	return fields
}

func organizationDetailFromRow(row machinelogbookdb.GetOrganizationDetailRow) Organization {
	item := Organization{
		ID:     row.ID,
		Name:   row.Name,
		Kind:   OrganizationKind(row.Kind),
		Active: row.Active,
		OrganizationDetails: OrganizationDetails{
			AddressLine:  row.AddressLine,
			PostalCode:   row.PostalCode,
			Locality:     row.Locality,
			CountryCode:  row.CountryCode,
			ContactName:  row.ContactName,
			ContactEmail: row.ContactEmail,
		},
		MemberCount:                   row.MemberCount,
		PricingGroupAssignmentVersion: row.PricingGroupAssignmentVersion,
		Version:                       row.Version,
		CreatedAt:                     row.CreatedAt,
		UpdatedAt:                     row.UpdatedAt,
	}
	if row.PricingGroupID != nil && row.PricingGroupName != nil {
		item.PricingGroup = &PricingGroupSummary{ID: *row.PricingGroupID, Name: *row.PricingGroupName}
	}
	return item
}

func (s *Service) loadOrganization(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	id uuid.UUID,
) (Organization, error) {
	row, err := q.GetOrganizationDetail(ctx, id)
	if err != nil {
		return Organization{}, noRows(err)
	}
	return organizationDetailFromRow(row), nil
}

func (s *Service) GetOrganization(ctx context.Context, p authorization.Principal, id uuid.UUID) (Organization, error) {
	if err := require(p, authorization.OrganizationsRead); err != nil {
		return Organization{}, err
	}
	return s.loadOrganization(ctx, machinelogbookdb.New(s.pool), id)
}

func (s *Service) ListOrganizations(
	ctx context.Context,
	p authorization.Principal,
	f OrganizationFilters,
) ([]Organization, int64, error) {
	if err := require(p, authorization.OrganizationsRead); err != nil {
		return nil, 0, err
	}
	if f.Kind != nil {
		if err := validateOrganizationKind(*f.Kind); err != nil {
			return nil, 0, err
		}
	}
	offset, limit, err := pageBounds(f.Page, f.PageSize)
	if err != nil {
		return nil, 0, err
	}
	q := machinelogbookdb.New(s.pool)
	search := strings.TrimSpace(f.Search)
	rows, err := q.ListOrganizations(
		ctx,
		machinelogbookdb.ListOrganizationsParams{
			Search:         search,
			Active:         f.Active,
			Kind:           optional.Convert[string](f.Kind),
			PricingGroupID: f.PricingGroupID,
			PageOffset:     offset,
			PageLimit:      limit,
		},
	)
	if err != nil {
		return nil, 0, err
	}
	total, err := q.CountOrganizations(
		ctx,
		machinelogbookdb.CountOrganizationsParams{
			Search:         search,
			Active:         f.Active,
			Kind:           optional.Convert[string](f.Kind),
			PricingGroupID: f.PricingGroupID,
		},
	)
	if err != nil {
		return nil, 0, err
	}
	items := make([]Organization, 0, len(rows))
	for _, row := range rows {
		items = append(items, organizationDetailFromRow(machinelogbookdb.GetOrganizationDetailRow(row)))
	}
	return items, total, nil
}

func (s *Service) CreateOrganization(
	ctx context.Context,
	p authorization.Principal,
	name string,
	kind OrganizationKind,
	details OrganizationDetailsInput,
	requestID *uuid.UUID,
) (Organization, error) {
	if err := require(p, authorization.OrganizationsManage); err != nil {
		return Organization{}, err
	}
	var err error
	name, err = validateName(name)
	if err != nil {
		return Organization{}, err
	}
	if err = validateOrganizationKind(kind); err != nil {
		return Organization{}, err
	}
	merged, err := mergeOrganizationDetails(OrganizationDetails{}, details)
	if err != nil {
		return Organization{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Organization{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	id := ids.New()
	row, err := machinelogbookdb.New(tx).
		CreateOrganization(
			ctx,
			machinelogbookdb.CreateOrganizationParams{
				ID:           id,
				Name:         name,
				Kind:         string(kind),
				AddressLine:  merged.AddressLine,
				PostalCode:   merged.PostalCode,
				Locality:     merged.Locality,
				CountryCode:  merged.CountryCode,
				ContactName:  merged.ContactName,
				ContactEmail: merged.ContactEmail,
			},
		)
	if err != nil {
		return Organization{}, databaseError(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"organization.created",
		"organization",
		id,
		requestID,
		append([]string{"name", "kind"}, changedOrganizationDetailFields(details)...),
	); err != nil {
		return Organization{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Organization{}, err
	}
	return organizationFromRow(row), nil
}

// DeleteOrganization hard-deletes an organization nothing historical refers to.
// Members, the pricing group assignment and invoicing requirements cascade; the
// remaining foreign keys are ON DELETE SET NULL, so referenced organizations are
// refused instead of silently losing history.
func (s *Service) DeleteOrganization(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if err := require(p, authorization.OrganizationsManage); err != nil {
		return err
	}
	if expected < 1 {
		return apperror.Invalid("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	current, err := q.GetOrganizationForUpdate(ctx, id)
	if err != nil {
		return noRows(err)
	}
	if current.Version != expected {
		return apperror.StaleWrite
	}
	referenced, err := q.OrganizationIsReferenced(ctx, id)
	if err != nil {
		return err
	}
	if referenced {
		return apperror.Conflicting(
			"organization_in_use",
			"The organization is referenced by jobs, orders or invoice requests and cannot be deleted; deactivate it instead",
		)
	}
	rows, err := q.DeleteOrganization(ctx, machinelogbookdb.DeleteOrganizationParams{ID: id, ExpectedVersion: expected})
	if err != nil {
		return databaseError(err)
	}
	if rows == 0 {
		return apperror.StaleWrite
	}
	if err = writeAudit(ctx, tx, p, "organization.deleted", "organization", id, requestID, nil); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) UpdateOrganization(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	name string,
	kind OrganizationKind,
	active bool,
	details OrganizationDetailsInput,
	requestID *uuid.UUID,
) (Organization, error) {
	if err := require(p, authorization.OrganizationsManage); err != nil {
		return Organization{}, err
	}
	if expected < 1 {
		return Organization{}, apperror.Invalid("expectedVersion must be positive")
	}
	var err error
	name, err = validateName(name)
	if err != nil {
		return Organization{}, err
	}
	if err = validateOrganizationKind(kind); err != nil {
		return Organization{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Organization{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	current, err := q.GetOrganizationForUpdate(ctx, id)
	if err != nil {
		return Organization{}, noRows(err)
	}
	if current.Version != expected {
		return Organization{}, apperror.StaleWrite
	}
	merged, err := mergeOrganizationDetails(organizationFromRow(current).OrganizationDetails, details)
	if err != nil {
		return Organization{}, err
	}
	_, err = q.UpdateOrganization(
		ctx,
		machinelogbookdb.UpdateOrganizationParams{
			Name:            name,
			Kind:            string(kind),
			Active:          active,
			AddressLine:     merged.AddressLine,
			PostalCode:      merged.PostalCode,
			Locality:        merged.Locality,
			CountryCode:     merged.CountryCode,
			ContactName:     merged.ContactName,
			ContactEmail:    merged.ContactEmail,
			ID:              id,
			ExpectedVersion: expected,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Organization{}, apperror.StaleWrite
	}
	if err != nil {
		return Organization{}, databaseError(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"organization.updated",
		"organization",
		id,
		requestID,
		append([]string{"name", "kind", "active"}, changedOrganizationDetailFields(details)...),
	); err != nil {
		return Organization{}, err
	}
	result, err := s.loadOrganization(ctx, q, id)
	if err != nil {
		return Organization{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Organization{}, err
	}
	return result, nil
}

func (s *Service) ListOrganizationMembers(
	ctx context.Context,
	p authorization.Principal,
	organizationID uuid.UUID,
) ([]OrganizationMember, error) {
	if err := require(p, authorization.OrganizationsRead); err != nil {
		return nil, err
	}
	q := machinelogbookdb.New(s.pool)
	if _, err := q.GetOrganization(ctx, organizationID); err != nil {
		return nil, noRows(err)
	}
	rows, err := q.ListOrganizationMembers(ctx, organizationID)
	if err != nil {
		return nil, err
	}
	items := make([]OrganizationMember, 0, len(rows))
	for _, row := range rows {
		items = append(
			items,
			OrganizationMember{PersonID: row.PersonID, DisplayName: row.DisplayName, AddedAt: row.AddedAt},
		)
	}
	return items, nil
}

// AddOrganizationMember associates a person with an organization. Membership
// is informational: it never limits who may order for the organization.
func (s *Service) AddOrganizationMember(
	ctx context.Context,
	p authorization.Principal,
	organizationID, personID uuid.UUID,
	requestID *uuid.UUID,
) (OrganizationMember, error) {
	if err := require(p, authorization.OrganizationsManage); err != nil {
		return OrganizationMember{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return OrganizationMember{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	if _, err = q.GetOrganizationForUpdate(ctx, organizationID); err != nil {
		return OrganizationMember{}, noRows(err)
	}
	person, err := q.GetBillingPerson(ctx, personID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return OrganizationMember{}, apperror.Invalid("person does not exist")
		}
		return OrganizationMember{}, err
	}
	addedAt, err := q.AddOrganizationMember(
		ctx,
		machinelogbookdb.AddOrganizationMemberParams{OrganizationID: organizationID, PersonID: personID},
	)
	if err != nil {
		return OrganizationMember{}, databaseError(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"organization.member_added",
		"organization",
		organizationID,
		requestID,
		[]string{"members"},
	); err != nil {
		return OrganizationMember{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return OrganizationMember{}, err
	}
	return OrganizationMember{PersonID: personID, DisplayName: person.DisplayName, AddedAt: addedAt}, nil
}

func (s *Service) RemoveOrganizationMember(
	ctx context.Context,
	p authorization.Principal,
	organizationID, personID uuid.UUID,
	requestID *uuid.UUID,
) error {
	if err := require(p, authorization.OrganizationsManage); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	if _, err = q.RemoveOrganizationMember(
		ctx,
		machinelogbookdb.RemoveOrganizationMemberParams{OrganizationID: organizationID, PersonID: personID},
	); err != nil {
		return noRows(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"organization.member_removed",
		"organization",
		organizationID,
		requestID,
		[]string{"members"},
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func canLookupParties(p authorization.Principal) bool {
	return p.Has(authorization.OrdersRead) || p.Has(authorization.MachineJobsCreate) ||
		p.Has(authorization.OrganizationsRead)
}

func (s *Service) SearchBillingParties(
	ctx context.Context,
	p authorization.Principal,
	search string,
	limit int,
) ([]BillingParty, error) {
	if !canLookupParties(p) {
		return nil, apperror.PermissionDenied
	}
	if limit < 1 || limit > 50 {
		return nil, apperror.Invalid("limit must be between 1 and 50")
	}
	rows, err := machinelogbookdb.New(s.pool).
		SearchBillingParties(
			ctx,
			machinelogbookdb.SearchBillingPartiesParams{Search: strings.TrimSpace(search), PageLimit: int32(limit)},
		)
	if err != nil {
		return nil, err
	}
	items := make([]BillingParty, 0, len(rows))
	for _, row := range rows {
		item := BillingParty{
			ID:                            row.PartyID,
			Kind:                          PartyKind(row.PartyKind),
			DisplayName:                   row.DisplayName,
			OrganizationKind:              optional.Convert[OrganizationKind](row.OrganizationKind),
			PricingGroupAssignmentVersion: row.PricingGroupAssignmentVersion,
		}
		if row.PricingGroupID != nil && row.PricingGroupName != nil {
			item.PricingGroup = &PricingGroupSummary{ID: *row.PricingGroupID, Name: *row.PricingGroupName}
		}
		items = append(items, item)
	}
	return s.attachMemberOrganizations(ctx, items)
}

// attachMemberOrganizations adds the active organizations of each person
// result so job forms can suggest one. It reveals nothing beyond names.
func (s *Service) attachMemberOrganizations(ctx context.Context, items []BillingParty) ([]BillingParty, error) {
	var ids []uuid.UUID
	for _, item := range items {
		if item.Kind == PartyPerson {
			ids = append(ids, item.ID)
		}
	}
	if len(ids) == 0 {
		return items, nil
	}
	rows, err := machinelogbookdb.New(s.pool).ListActiveOrganizationsOfPeople(ctx, ids)
	if err != nil {
		return nil, err
	}
	byPerson := map[uuid.UUID][]OrganizationReference{}
	for _, row := range rows {
		byPerson[row.PersonID] = append(
			byPerson[row.PersonID],
			OrganizationReference{ID: row.OrganizationID, Name: row.OrganizationName},
		)
	}
	for i := range items {
		if items[i].Kind == PartyPerson {
			items[i].MemberOrganizations = append([]OrganizationReference{}, byPerson[items[i].ID]...)
		}
	}
	return items, nil
}

func (s *Service) SearchOperators(
	ctx context.Context,
	p authorization.Principal,
	search string,
	limit int,
) ([]Operator, error) {
	if !canLookupParties(p) {
		return nil, apperror.PermissionDenied
	}
	if limit < 1 || limit > 50 {
		return nil, apperror.Invalid("limit must be between 1 and 50")
	}
	rows, err := machinelogbookdb.New(s.pool).
		SearchMachineJobOperators(
			ctx,
			machinelogbookdb.SearchMachineJobOperatorsParams{
				Search:    strings.TrimSpace(search),
				PageLimit: int32(limit),
			},
		)
	if err != nil {
		return nil, err
	}
	items := make([]Operator, 0, len(rows))
	for _, row := range rows {
		items = append(items, Operator{PersonID: row.PersonID, DisplayName: row.DisplayName})
	}
	return items, nil
}
