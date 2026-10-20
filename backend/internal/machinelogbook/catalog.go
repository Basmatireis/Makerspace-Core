package machinelogbook

import (
	"context"
	"errors"
	"net/mail"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ListMachineTypes(ctx context.Context, p authorization.Principal) ([]MachineType, error) {
	if err := require(p, authorization.MachinesRead); err != nil {
		return nil, err
	}
	rows, err := machinelogbookdb.New(s.pool).ListMachineTypes(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]MachineType, 0, len(rows))
	for _, row := range rows {
		items = append(items, machineTypeFromRow(row))
	}
	return items, nil
}

func (s *Service) CreateMachineType(ctx context.Context, p authorization.Principal, name, process string, requestID *uuid.UUID) (MachineType, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return MachineType{}, err
	}
	name, err := validateName(name)
	if err != nil {
		return MachineType{}, err
	}
	if !validProcess(process) {
		return MachineType{}, validation("invalid machine process")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineType{}, err
	}
	defer tx.Rollback(ctx)
	id := newID()
	row, err := machinelogbookdb.New(tx).CreateMachineType(ctx, machinelogbookdb.CreateMachineTypeParams{ID: id, Name: name, Process: process})
	if err != nil {
		return MachineType{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "machine_type.created", "machine_type", id, requestID, []string{"name", "process"}); err != nil {
		return MachineType{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineType{}, err
	}
	return machineTypeFromRow(row), nil
}

func (s *Service) UpdateMachineType(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, name *string, active *bool, process *string, requestID *uuid.UUID) (MachineType, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return MachineType{}, err
	}
	if expected < 1 {
		return MachineType{}, validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineType{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	current, err := q.GetMachineTypeForUpdate(ctx, id)
	if err != nil {
		return MachineType{}, noRows(err)
	}
	if current.Version != expected {
		return MachineType{}, apperror.StaleWrite
	}
	if name != nil {
		current.Name, err = validateName(*name)
		if err != nil {
			return MachineType{}, err
		}
	}
	if active != nil {
		current.Active = *active
	}
	if process != nil {
		if !validProcess(*process) {
			return MachineType{}, validation("invalid machine process")
		}
		current.Process = *process
	}
	row, err := q.UpdateMachineType(ctx, machinelogbookdb.UpdateMachineTypeParams{Name: current.Name, Active: current.Active, Process: current.Process, ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return MachineType{}, apperror.StaleWrite
	}
	if err != nil {
		return MachineType{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "machine_type.updated", "machine_type", id, requestID, []string{"name", "active", "process"}); err != nil {
		return MachineType{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineType{}, err
	}
	return machineTypeFromRow(row), nil
}

func validateMachine(status string, automatic bool, external *string) error {
	if status != "active" && status != "maintenance" && status != "retired" {
		return validation("invalid machine status")
	}
	if cleanOptional(external) != nil && !automatic {
		return validation("externalIdentifier requires automatic collection")
	}
	return nil
}

func machineFromGet(row machinelogbookdb.GetMachineRow) Machine {
	return Machine{ID: row.ID, MachineType: MachineType{ID: row.MachineTypeID, Name: row.MachineTypeName, Active: row.MachineTypeActive, Process: row.MachineTypeProcess, Version: row.MachineTypeVersion, CreatedAt: row.MachineTypeCreatedAt, UpdatedAt: row.MachineTypeUpdatedAt}, Name: row.Name, Status: row.Status, ExternalIdentifier: row.ExternalIdentifier, AutomaticCollectionEnabled: row.AutomaticCollectionEnabled, LastIngestedAt: nullableTime(row.LastIngestedAt), Version: row.Version, JobCount: row.JobCount, RuntimeSeconds: row.RuntimeSeconds, FailureRate: decimalString(row.FailureRate), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func machineFromList(row machinelogbookdb.ListMachinesRow) Machine {
	return Machine{ID: row.ID, MachineType: MachineType{ID: row.MachineTypeID, Name: row.MachineTypeName, Active: row.MachineTypeActive, Process: row.MachineTypeProcess, Version: row.MachineTypeVersion, CreatedAt: row.MachineTypeCreatedAt, UpdatedAt: row.MachineTypeUpdatedAt}, Name: row.Name, Status: row.Status, ExternalIdentifier: row.ExternalIdentifier, AutomaticCollectionEnabled: row.AutomaticCollectionEnabled, LastIngestedAt: nullableTime(row.LastIngestedAt), Version: row.Version, JobCount: row.JobCount, RuntimeSeconds: row.RuntimeSeconds, FailureRate: decimalString(row.FailureRate), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func (s *Service) GetMachine(ctx context.Context, p authorization.Principal, id uuid.UUID) (Machine, error) {
	if err := require(p, authorization.MachinesRead); err != nil {
		return Machine{}, err
	}
	return s.loadMachine(ctx, id)
}

func (s *Service) loadMachine(ctx context.Context, id uuid.UUID) (Machine, error) {
	row, err := machinelogbookdb.New(s.pool).GetMachine(ctx, id)
	if err != nil {
		return Machine{}, noRows(err)
	}
	return machineFromGet(row), nil
}

func (s *Service) ListMachines(ctx context.Context, p authorization.Principal, search string, status *string, page, pageSize int) ([]Machine, int64, error) {
	if err := require(p, authorization.MachinesRead); err != nil {
		return nil, 0, err
	}
	offset, limit, err := pageBounds(page, pageSize)
	if err != nil {
		return nil, 0, err
	}
	q := machinelogbookdb.New(s.pool)
	rows, err := q.ListMachines(ctx, machinelogbookdb.ListMachinesParams{Search: strings.TrimSpace(search), Status: status, PageOffset: offset, PageLimit: limit})
	if err != nil {
		return nil, 0, err
	}
	total, err := q.CountMachines(ctx, machinelogbookdb.CountMachinesParams{Search: strings.TrimSpace(search), Status: status})
	if err != nil {
		return nil, 0, err
	}
	items := make([]Machine, 0, len(rows))
	for _, row := range rows {
		items = append(items, machineFromList(row))
	}
	return items, total, nil
}

func (s *Service) CreateMachine(ctx context.Context, p authorization.Principal, machineTypeID uuid.UUID, name, status string, external *string, automatic bool, requestID *uuid.UUID) (Machine, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return Machine{}, err
	}
	var err error
	name, err = validateName(name)
	if err != nil {
		return Machine{}, err
	}
	external = cleanOptional(external)
	if err = validateMachine(status, automatic, external); err != nil {
		return Machine{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Machine{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	typeRow, err := q.GetMachineType(ctx, machineTypeID)
	if err != nil {
		return Machine{}, noRows(err)
	}
	if !typeRow.Active {
		return Machine{}, conflict("machine_type_inactive", "Machine type is inactive")
	}
	id := newID()
	_, err = q.CreateMachine(ctx, machinelogbookdb.CreateMachineParams{ID: id, MachineTypeID: machineTypeID, Name: name, Status: status, ExternalIdentifier: external, AutomaticCollectionEnabled: automatic})
	if err != nil {
		return Machine{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "machine.created", "machine", id, requestID, []string{"machineTypeId", "name", "status", "externalIdentifier", "automaticCollectionEnabled"}); err != nil {
		return Machine{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Machine{}, err
	}
	return s.loadMachine(ctx, id)
}

func (s *Service) UpdateMachine(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, machineTypeID uuid.UUID, name, status string, external *string, automatic bool, requestID *uuid.UUID) (Machine, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return Machine{}, err
	}
	if expected < 1 {
		return Machine{}, validation("expectedVersion must be positive")
	}
	var err error
	name, err = validateName(name)
	if err != nil {
		return Machine{}, err
	}
	external = cleanOptional(external)
	if err = validateMachine(status, automatic, external); err != nil {
		return Machine{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Machine{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	current, err := q.GetMachineForUpdate(ctx, id)
	if err != nil {
		return Machine{}, noRows(err)
	}
	if current.Version != expected {
		return Machine{}, apperror.StaleWrite
	}
	typeRow, err := q.GetMachineType(ctx, machineTypeID)
	if err != nil {
		return Machine{}, noRows(err)
	}
	if !typeRow.Active && machineTypeID != current.MachineTypeID {
		return Machine{}, conflict("machine_type_inactive", "Machine type is inactive")
	}
	_, err = q.UpdateMachine(ctx, machinelogbookdb.UpdateMachineParams{MachineTypeID: machineTypeID, Name: name, Status: status, ExternalIdentifier: external, AutomaticCollectionEnabled: automatic, ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return Machine{}, apperror.StaleWrite
	}
	if err != nil {
		return Machine{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "machine.updated", "machine", id, requestID, []string{"machineTypeId", "name", "status", "externalIdentifier", "automaticCollectionEnabled"}); err != nil {
		return Machine{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Machine{}, err
	}
	return s.loadMachine(ctx, id)
}

// DeleteMachine permanently deletes a machine that has no jobs or runs, with
// its printer setup, connector assignments, diagnostics and the tombstones of
// its deleted jobs and runs. Machines with history are retired instead.
func (s *Service) DeleteMachine(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, requestID *uuid.UUID) error {
	if err := require(p, authorization.MachinesManage); err != nil {
		return err
	}
	if expected < 1 {
		return validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	current, err := q.GetMachineForUpdate(ctx, id)
	if err != nil {
		return noRows(err)
	}
	if current.Version != expected {
		return apperror.StaleWrite
	}
	connected, err := q.MachineHasConnectorAssignments(ctx, id)
	if err != nil {
		return err
	}
	if connected {
		if err = require(p, authorization.PrinterConnectorsManage); err != nil {
			return err
		}
	}
	inUse, err := q.MachineHasActiveWork(ctx, id)
	if err != nil {
		return err
	}
	if inUse {
		return conflict("machine_in_use", "The machine has jobs or runs and cannot be deleted; retire it instead")
	}
	mounted, err := q.MachineHasMountedSpool(ctx, id)
	if err != nil {
		return err
	}
	if mounted {
		return conflict("machine_has_mounted_spools", "Unmount the spools of this machine before deleting it")
	}
	// Order matters: runs go before printer events and assignments they reference.
	for _, step := range []func(context.Context, uuid.UUID) error{
		q.BumpConnectorsOfDeletedMachine, q.DeleteMachineErrorOccurrences, q.DeleteMachineRunsOfMachine, q.DeleteMachineJobsOfMachine,
		q.DeleteMachinePrinterEvents, q.DeleteMachineSpoolMountHistory, q.DeleteMachineConnectorAssignments,
	} {
		if err = step(ctx, id); err != nil {
			return databaseError(err)
		}
	}
	rows, err := q.DeleteMachine(ctx, machinelogbookdb.DeleteMachineParams{ID: id, ExpectedVersion: expected})
	if err != nil {
		return databaseError(err)
	}
	if rows == 0 {
		return apperror.StaleWrite
	}
	if err = writeAudit(ctx, tx, p, "machine.deleted", "machine", id, requestID, nil); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func organizationFromRow(row machinelogbookdb.Organization) Organization {
	return Organization{ID: row.ID, Name: row.Name, Kind: row.Kind, Active: row.Active, OrganizationDetails: OrganizationDetails{AddressLine: row.AddressLine, PostalCode: row.PostalCode, Locality: row.Locality, CountryCode: row.CountryCode, ContactName: row.ContactName, ContactEmail: row.ContactEmail}, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}
func validateOrganizationKind(kind string) error {
	if kind != "company" && kind != "institute" && kind != "association" && kind != "other" {
		return validation("invalid organization kind")
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
			return validation(field + " is too long")
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
			return OrganizationDetails{}, validation("countryCode must be a two-letter ISO 3166-1 code")
		}
		out.CountryCode = code
	}
	if out.ContactEmail != "" {
		addr, err := mail.ParseAddress(out.ContactEmail)
		if err != nil || addr.Address != out.ContactEmail || addr.Name != "" {
			return OrganizationDetails{}, validation("contactEmail must be a plain email address")
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
	item := Organization{ID: row.ID, Name: row.Name, Kind: row.Kind, Active: row.Active, OrganizationDetails: OrganizationDetails{AddressLine: row.AddressLine, PostalCode: row.PostalCode, Locality: row.Locality, CountryCode: row.CountryCode, ContactName: row.ContactName, ContactEmail: row.ContactEmail}, MemberCount: row.MemberCount, PricingGroupAssignmentVersion: row.PricingGroupAssignmentVersion, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
	if row.PricingGroupID != nil && row.PricingGroupName != nil {
		item.PricingGroup = &PricingGroupSummary{ID: *row.PricingGroupID, Name: *row.PricingGroupName}
	}
	return item
}

func (s *Service) loadOrganization(ctx context.Context, q *machinelogbookdb.Queries, id uuid.UUID) (Organization, error) {
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

func (s *Service) ListOrganizations(ctx context.Context, p authorization.Principal, f OrganizationFilters) ([]Organization, int64, error) {
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
	rows, err := q.ListOrganizations(ctx, machinelogbookdb.ListOrganizationsParams{Search: search, Active: f.Active, Kind: f.Kind, PricingGroupID: f.PricingGroupID, PageOffset: offset, PageLimit: limit})
	if err != nil {
		return nil, 0, err
	}
	total, err := q.CountOrganizations(ctx, machinelogbookdb.CountOrganizationsParams{Search: search, Active: f.Active, Kind: f.Kind, PricingGroupID: f.PricingGroupID})
	if err != nil {
		return nil, 0, err
	}
	items := make([]Organization, 0, len(rows))
	for _, row := range rows {
		items = append(items, organizationDetailFromRow(machinelogbookdb.GetOrganizationDetailRow(row)))
	}
	return items, total, nil
}

func (s *Service) CreateOrganization(ctx context.Context, p authorization.Principal, name, kind string, details OrganizationDetailsInput, requestID *uuid.UUID) (Organization, error) {
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
	defer tx.Rollback(ctx)
	id := newID()
	row, err := machinelogbookdb.New(tx).CreateOrganization(ctx, machinelogbookdb.CreateOrganizationParams{ID: id, Name: name, Kind: kind, AddressLine: merged.AddressLine, PostalCode: merged.PostalCode, Locality: merged.Locality, CountryCode: merged.CountryCode, ContactName: merged.ContactName, ContactEmail: merged.ContactEmail})
	if err != nil {
		return Organization{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "organization.created", "organization", id, requestID, append([]string{"name", "kind"}, changedOrganizationDetailFields(details)...)); err != nil {
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
func (s *Service) DeleteOrganization(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, requestID *uuid.UUID) error {
	if err := require(p, authorization.OrganizationsManage); err != nil {
		return err
	}
	if expected < 1 {
		return validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
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
		return conflict("organization_in_use", "The organization is referenced by jobs, orders or invoice requests and cannot be deleted; deactivate it instead")
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

func (s *Service) UpdateOrganization(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, name, kind string, active bool, details OrganizationDetailsInput, requestID *uuid.UUID) (Organization, error) {
	if err := require(p, authorization.OrganizationsManage); err != nil {
		return Organization{}, err
	}
	if expected < 1 {
		return Organization{}, validation("expectedVersion must be positive")
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
	defer tx.Rollback(ctx)
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
	_, err = q.UpdateOrganization(ctx, machinelogbookdb.UpdateOrganizationParams{Name: name, Kind: kind, Active: active, AddressLine: merged.AddressLine, PostalCode: merged.PostalCode, Locality: merged.Locality, CountryCode: merged.CountryCode, ContactName: merged.ContactName, ContactEmail: merged.ContactEmail, ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return Organization{}, apperror.StaleWrite
	}
	if err != nil {
		return Organization{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "organization.updated", "organization", id, requestID, append([]string{"name", "kind", "active"}, changedOrganizationDetailFields(details)...)); err != nil {
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

func (s *Service) ListOrganizationMembers(ctx context.Context, p authorization.Principal, organizationID uuid.UUID) ([]OrganizationMember, error) {
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
		items = append(items, OrganizationMember{PersonID: row.PersonID, DisplayName: row.DisplayName, AddedAt: row.AddedAt})
	}
	return items, nil
}

// AddOrganizationMember associates a person with an organization. Membership
// is informational: it never limits who may order for the organization.
func (s *Service) AddOrganizationMember(ctx context.Context, p authorization.Principal, organizationID, personID uuid.UUID, requestID *uuid.UUID) (OrganizationMember, error) {
	if err := require(p, authorization.OrganizationsManage); err != nil {
		return OrganizationMember{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return OrganizationMember{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	if _, err = q.GetOrganizationForUpdate(ctx, organizationID); err != nil {
		return OrganizationMember{}, noRows(err)
	}
	person, err := q.GetBillingPerson(ctx, personID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return OrganizationMember{}, validation("person does not exist")
		}
		return OrganizationMember{}, err
	}
	addedAt, err := q.AddOrganizationMember(ctx, machinelogbookdb.AddOrganizationMemberParams{OrganizationID: organizationID, PersonID: personID})
	if err != nil {
		return OrganizationMember{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "organization.member_added", "organization", organizationID, requestID, []string{"members"}); err != nil {
		return OrganizationMember{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return OrganizationMember{}, err
	}
	return OrganizationMember{PersonID: personID, DisplayName: person.DisplayName, AddedAt: addedAt}, nil
}

func (s *Service) RemoveOrganizationMember(ctx context.Context, p authorization.Principal, organizationID, personID uuid.UUID, requestID *uuid.UUID) error {
	if err := require(p, authorization.OrganizationsManage); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	if _, err = q.RemoveOrganizationMember(ctx, machinelogbookdb.RemoveOrganizationMemberParams{OrganizationID: organizationID, PersonID: personID}); err != nil {
		return noRows(err)
	}
	if err = writeAudit(ctx, tx, p, "organization.member_removed", "organization", organizationID, requestID, []string{"members"}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func canLookupParties(p authorization.Principal) bool {
	return p.Has(authorization.OrdersRead) || p.Has(authorization.MachineJobsCreate) || p.Has(authorization.OrganizationsRead)
}
func (s *Service) SearchBillingParties(ctx context.Context, p authorization.Principal, search string, limit int) ([]BillingParty, error) {
	if !canLookupParties(p) {
		return nil, apperror.PermissionDenied
	}
	if limit < 1 || limit > 50 {
		return nil, validation("limit must be between 1 and 50")
	}
	rows, err := machinelogbookdb.New(s.pool).SearchBillingParties(ctx, machinelogbookdb.SearchBillingPartiesParams{Search: strings.TrimSpace(search), PageLimit: int32(limit)})
	if err != nil {
		return nil, err
	}
	items := make([]BillingParty, 0, len(rows))
	for _, row := range rows {
		item := BillingParty{ID: row.PartyID, Kind: row.PartyKind, DisplayName: row.DisplayName, OrganizationKind: row.OrganizationKind, PricingGroupAssignmentVersion: row.PricingGroupAssignmentVersion}
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
		if item.Kind == "person" {
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
		byPerson[row.PersonID] = append(byPerson[row.PersonID], OrganizationReference{ID: row.OrganizationID, Name: row.OrganizationName})
	}
	for i := range items {
		if items[i].Kind == "person" {
			items[i].MemberOrganizations = append([]OrganizationReference{}, byPerson[items[i].ID]...)
		}
	}
	return items, nil
}
func (s *Service) SearchOperators(ctx context.Context, p authorization.Principal, search string, limit int) ([]Operator, error) {
	if !canLookupParties(p) {
		return nil, apperror.PermissionDenied
	}
	if limit < 1 || limit > 50 {
		return nil, validation("limit must be between 1 and 50")
	}
	rows, err := machinelogbookdb.New(s.pool).SearchMachineJobOperators(ctx, machinelogbookdb.SearchMachineJobOperatorsParams{Search: strings.TrimSpace(search), PageLimit: int32(limit)})
	if err != nil {
		return nil, err
	}
	items := make([]Operator, 0, len(rows))
	for _, row := range rows {
		items = append(items, Operator{PersonID: row.PersonID, DisplayName: row.DisplayName})
	}
	return items, nil
}

func pricingRuleFromRow(row machinelogbookdb.PricingRule, materialTypeName *string) PricingRule {
	return PricingRule{ID: row.ID, PricingGroupID: row.PricingGroupID, Kind: row.Kind, MachineTypeID: row.MachineTypeID, MaterialTypeID: row.MaterialTypeID, MaterialTypeName: materialTypeName, MaterialUnit: row.MaterialUnit, Measure: row.Measure, BlockSize: row.BlockSize, Rate: decimalString(row.Rate), Active: row.Active, Version: row.Version}
}
func (s *Service) pricingGroupFromRow(ctx context.Context, q *machinelogbookdb.Queries, row machinelogbookdb.PricingGroup) (PricingGroup, error) {
	rules, err := q.ListPricingRulesByGroup(ctx, row.ID)
	if err != nil {
		return PricingGroup{}, err
	}
	item := PricingGroup{ID: row.ID, Name: row.Name, Description: row.Description, Active: row.Active, IsDefault: row.IsDefault, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, Rules: make([]PricingRule, 0, len(rules))}
	for _, r := range rules {
		item.Rules = append(item.Rules, pricingRuleFromRow(machinelogbookdb.PricingRule{ID: r.ID, PricingGroupID: r.PricingGroupID, Kind: r.Kind, MachineTypeID: r.MachineTypeID, MaterialUnit: r.MaterialUnit, Measure: r.Measure, BlockSize: r.BlockSize, Rate: r.Rate, Active: r.Active, Version: r.Version, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt, MaterialTypeID: r.MaterialTypeID}, r.MaterialTypeName))
	}
	return item, nil
}

func (s *Service) ListPricingGroups(ctx context.Context, p authorization.Principal) ([]PricingGroup, error) {
	if err := require(p, authorization.PricingRead); err != nil {
		return nil, err
	}
	q := machinelogbookdb.New(s.pool)
	rows, err := q.ListPricingGroups(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]PricingGroup, 0, len(rows))
	for _, row := range rows {
		item, err := s.pricingGroupFromRow(ctx, q, row)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

func (s *Service) CreatePricingGroup(ctx context.Context, p authorization.Principal, name string, description *string, isDefault bool, requestID *uuid.UUID) (PricingGroup, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return PricingGroup{}, err
	}
	var err error
	name, err = validateName(name)
	if err != nil {
		return PricingGroup{}, err
	}
	description = cleanOptional(description)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PricingGroup{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	id := newID()
	if isDefault {
		if err = q.ClearDefaultPricingGroup(ctx, id); err != nil {
			return PricingGroup{}, err
		}
	}
	row, err := q.CreatePricingGroup(ctx, machinelogbookdb.CreatePricingGroupParams{ID: id, Name: name, Description: description, IsDefault: isDefault})
	if err != nil {
		return PricingGroup{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "pricing_group.created", "pricing_group", id, requestID, []string{"name", "description", "isDefault"}); err != nil {
		return PricingGroup{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PricingGroup{}, err
	}
	return s.pricingGroupFromRow(ctx, machinelogbookdb.New(s.pool), row)
}

func (s *Service) UpdatePricingGroup(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, name string, description *string, active, isDefault bool, requestID *uuid.UUID) (PricingGroup, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return PricingGroup{}, err
	}
	if expected < 1 {
		return PricingGroup{}, validation("expectedVersion must be positive")
	}
	var err error
	name, err = validateName(name)
	if err != nil {
		return PricingGroup{}, err
	}
	description = cleanOptional(description)
	if isDefault && !active {
		return PricingGroup{}, validation("default pricing group must be active")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PricingGroup{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	current, err := q.GetPricingGroupForUpdate(ctx, id)
	if err != nil {
		return PricingGroup{}, noRows(err)
	}
	if current.Version != expected {
		return PricingGroup{}, apperror.StaleWrite
	}
	if isDefault {
		if err = q.ClearDefaultPricingGroup(ctx, id); err != nil {
			return PricingGroup{}, err
		}
	}
	row, err := q.UpdatePricingGroup(ctx, machinelogbookdb.UpdatePricingGroupParams{Name: name, Description: description, Active: active, IsDefault: isDefault, ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return PricingGroup{}, apperror.StaleWrite
	}
	if err != nil {
		return PricingGroup{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "pricing_group.updated", "pricing_group", id, requestID, []string{"name", "description", "active", "isDefault"}); err != nil {
		return PricingGroup{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PricingGroup{}, err
	}
	return s.pricingGroupFromRow(ctx, machinelogbookdb.New(s.pool), row)
}

// ruleTarget is what a pricing rule prices, resolved from its kind and selectors.
type ruleTarget struct {
	MaterialUnit, MaterialTypeName *string
	Measure                        *string
	BlockSize                      *int32
}

// resolveRuleTarget checks which selector a rule needs for its kind. For
// material rules it loads the material type whose unit the rule takes over; for
// measure rules it checks the machine type's process supports the measure and
// takes the block size of the measure.
func resolveRuleTarget(ctx context.Context, q *machinelogbookdb.Queries, kind string, machineTypeID, materialTypeID *uuid.UUID, measure *string, requireActiveType bool) (ruleTarget, error) {
	switch kind {
	case "machine_runtime":
		if machineTypeID == nil || materialTypeID != nil || measure != nil {
			return ruleTarget{}, validation("machine runtime rules require only machineTypeId")
		}
		return ruleTarget{}, nil
	case "material":
		if machineTypeID != nil || materialTypeID == nil || measure != nil {
			return ruleTarget{}, validation("material rules require only materialTypeId")
		}
		materialType, err := resolveMaterialType(ctx, q, *materialTypeID, requireActiveType)
		if err != nil {
			return ruleTarget{}, err
		}
		unit, name := materialType.Unit, materialType.Name
		return ruleTarget{MaterialUnit: &unit, MaterialTypeName: &name}, nil
	case "machine_measure":
		if machineTypeID == nil || materialTypeID != nil || measure == nil {
			return ruleTarget{}, validation("machine measure rules require machineTypeId and measure")
		}
		definition, known := measureDefinitions[*measure]
		if !known {
			return ruleTarget{}, validation("unknown measure")
		}
		machineType, err := q.GetMachineType(ctx, *machineTypeID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ruleTarget{}, validation("machineTypeId does not refer to a machine type")
		}
		if err != nil {
			return ruleTarget{}, err
		}
		if !processSupportsMeasure(machineType.Process, definition.Key) {
			return ruleTarget{}, apperror.New(422, "run_measure_unsupported", "The machine type's process does not record this measure")
		}
		block := definition.BlockSize
		return ruleTarget{Measure: &definition.Key, BlockSize: &block}, nil
	}
	return ruleTarget{}, validation("invalid pricing rule kind")
}

func (s *Service) CreatePricingRule(ctx context.Context, p authorization.Principal, groupID uuid.UUID, kind string, machineTypeID, materialTypeID *uuid.UUID, measure *string, rate string, requestID *uuid.UUID) (PricingRule, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return PricingRule{}, err
	}
	numeric, err := numericFromString(rate, false)
	if err != nil || decimalFromNumeric(numeric).IsNegative() {
		return PricingRule{}, validation("rate must be non-negative")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PricingRule{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	target, err := resolveRuleTarget(ctx, q, kind, machineTypeID, materialTypeID, measure, true)
	if err != nil {
		return PricingRule{}, err
	}
	group, err := q.GetPricingGroup(ctx, groupID)
	if err != nil {
		return PricingRule{}, noRows(err)
	}
	if !group.Active {
		return PricingRule{}, conflict("pricing_group_inactive", "Pricing group is inactive")
	}
	id := newID()
	row, err := q.CreatePricingRule(ctx, machinelogbookdb.CreatePricingRuleParams{ID: id, PricingGroupID: groupID, Kind: kind, MachineTypeID: machineTypeID, MaterialTypeID: materialTypeID, MaterialUnit: target.MaterialUnit, Measure: target.Measure, BlockSize: target.BlockSize, Rate: numeric})
	if err != nil {
		return PricingRule{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "pricing_rule.created", "pricing_rule", id, requestID, []string{"kind", "selector", "measure", "rate"}); err != nil {
		return PricingRule{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PricingRule{}, err
	}
	return pricingRuleFromRow(row, target.MaterialTypeName), nil
}

func (s *Service) UpdatePricingRule(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, kind string, machineTypeID, materialTypeID *uuid.UUID, measure *string, rate string, active bool, requestID *uuid.UUID) (PricingRule, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return PricingRule{}, err
	}
	if expected < 1 {
		return PricingRule{}, validation("expectedVersion must be positive")
	}
	numeric, err := numericFromString(rate, false)
	if err != nil || decimalFromNumeric(numeric).IsNegative() {
		return PricingRule{}, validation("rate must be non-negative")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PricingRule{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	current, err := q.GetPricingRuleForUpdate(ctx, id)
	if err != nil {
		return PricingRule{}, noRows(err)
	}
	if current.Version != expected {
		return PricingRule{}, apperror.StaleWrite
	}
	// A rule may keep its deactivated type; choosing another type needs an active one.
	target, err := resolveRuleTarget(ctx, q, kind, machineTypeID, materialTypeID, measure, !sameUUID(current.MaterialTypeID, materialTypeID))
	if err != nil {
		return PricingRule{}, err
	}
	row, err := q.UpdatePricingRule(ctx, machinelogbookdb.UpdatePricingRuleParams{Kind: kind, MachineTypeID: machineTypeID, MaterialTypeID: materialTypeID, MaterialUnit: target.MaterialUnit, Measure: target.Measure, BlockSize: target.BlockSize, Rate: numeric, Active: active, ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return PricingRule{}, apperror.StaleWrite
	}
	if err != nil {
		return PricingRule{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "pricing_rule.updated", "pricing_rule", id, requestID, []string{"kind", "selector", "measure", "rate", "active"}); err != nil {
		return PricingRule{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PricingRule{}, err
	}
	return pricingRuleFromRow(row, target.MaterialTypeName), nil
}

// SetPartyPricingGroup sets or clears the pricing group of an organization. People have no group of their own;
// they are priced through the role mapping (see SetRolePricingGroups).
func (s *Service) SetPartyPricingGroup(ctx context.Context, p authorization.Principal, party PartyReference, groupID *uuid.UUID, expected int64, requestID *uuid.UUID) (BillingParty, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return BillingParty{}, err
	}
	if party.Kind != "organization" {
		return BillingParty{}, validation("pricing groups are assigned to organizations; people are priced through their roles")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BillingParty{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	if groupID != nil {
		group, err := q.GetPricingGroup(ctx, *groupID)
		if err != nil {
			return BillingParty{}, noRows(err)
		}
		if !group.Active {
			return BillingParty{}, conflict("pricing_group_inactive", "Pricing group is inactive")
		}
		actor := p.AccountID
		_, err = q.UpsertOrganizationPricingAssignment(ctx, machinelogbookdb.UpsertOrganizationPricingAssignmentParams{OrganizationID: party.ID, PricingGroupID: *groupID, AssignedByAccountID: &actor, ExpectedVersion: expected})
		if errors.Is(err, pgx.ErrNoRows) {
			return BillingParty{}, apperror.StaleWrite
		}
		if err != nil {
			return BillingParty{}, databaseError(err)
		}
	} else {
		_, err = q.DeleteOrganizationPricingAssignment(ctx, machinelogbookdb.DeleteOrganizationPricingAssignmentParams{OrganizationID: party.ID, ExpectedVersion: expected})
		if errors.Is(err, pgx.ErrNoRows) {
			return BillingParty{}, apperror.StaleWrite
		}
		if err != nil {
			return BillingParty{}, err
		}
	}
	row, loadErr := q.GetBillingOrganization(ctx, party.ID)
	if loadErr != nil {
		return BillingParty{}, noRows(loadErr)
	}
	item := BillingParty{ID: row.ID, Kind: "organization", DisplayName: row.DisplayName, OrganizationKind: &row.OrganizationKind, PricingGroupAssignmentVersion: row.PricingGroupAssignmentVersion}
	if row.PricingGroupID != nil && row.PricingGroupName != nil {
		item.PricingGroup = &PricingGroupSummary{ID: *row.PricingGroupID, Name: *row.PricingGroupName}
	}
	if err = writeAudit(ctx, tx, p, "billing_party.pricing_group_updated", "billing_party", party.ID, requestID, []string{"pricingGroupId"}); err != nil {
		return BillingParty{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return BillingParty{}, err
	}
	return item, nil
}

// RolePricingGroup maps an account role to a pricing group. A larger priority wins when a person holds several mapped roles.
type RolePricingGroup struct {
	RoleID           uuid.UUID
	RoleName         string
	PricingGroupID   uuid.UUID
	PricingGroupName string
	Priority         int32
}

type RolePricingGroupInput struct {
	RoleID         uuid.UUID
	PricingGroupID uuid.UUID
	Priority       int32
}

const maxRolePriority = 1_000_000

func (s *Service) ListRolePricingGroups(ctx context.Context, p authorization.Principal) ([]RolePricingGroup, error) {
	if err := require(p, authorization.PricingRead); err != nil {
		return nil, err
	}
	return listRolePricingGroups(ctx, machinelogbookdb.New(s.pool))
}

func listRolePricingGroups(ctx context.Context, q *machinelogbookdb.Queries) ([]RolePricingGroup, error) {
	rows, err := q.ListRolePricingGroups(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]RolePricingGroup, 0, len(rows))
	for _, row := range rows {
		items = append(items, RolePricingGroup{RoleID: row.RoleID, RoleName: row.RoleName, PricingGroupID: row.PricingGroupID, PricingGroupName: row.PricingGroupName, Priority: row.Priority})
	}
	return items, nil
}

// SetRolePricingGroups replaces the whole role mapping atomically. Every role appears at most once, priorities are
// unique, and every group must exist and be active.
func (s *Service) SetRolePricingGroups(ctx context.Context, p authorization.Principal, input []RolePricingGroupInput, requestID *uuid.UUID) ([]RolePricingGroup, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return nil, err
	}
	if len(input) > 200 {
		return nil, validation("at most 200 role mappings")
	}
	roles := map[uuid.UUID]bool{}
	priorities := map[int32]bool{}
	for _, item := range input {
		if item.Priority < 1 || item.Priority > maxRolePriority {
			return nil, validation("priority must be between 1 and 1000000")
		}
		if roles[item.RoleID] {
			return nil, validation("each role can be mapped once")
		}
		if priorities[item.Priority] {
			return nil, validation("priorities must be unique")
		}
		roles[item.RoleID], priorities[item.Priority] = true, true
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	if err = q.LockRolePricingGroups(ctx); err != nil {
		return nil, err
	}
	for _, item := range input {
		ok, err := q.RoleExists(ctx, item.RoleID)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, apperror.NotFound
		}
		group, err := q.GetPricingGroup(ctx, item.PricingGroupID)
		if err != nil {
			return nil, noRows(err)
		}
		if !group.Active {
			return nil, conflict("pricing_group_inactive", "Pricing group is inactive")
		}
	}
	if err = q.DeleteRolePricingGroups(ctx); err != nil {
		return nil, err
	}
	actor := p.AccountID
	for _, item := range input {
		if err = q.InsertRolePricingGroup(ctx, machinelogbookdb.InsertRolePricingGroupParams{RoleID: item.RoleID, PricingGroupID: item.PricingGroupID, Priority: item.Priority, UpdatedByAccountID: &actor}); err != nil {
			return nil, databaseError(err)
		}
	}
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: accountPointer(p), Action: "pricing.role_groups_updated", ResourceType: "pricing_role_groups", RequestID: requestID, ChangedFields: []string{"roleMapping"}}); err != nil {
		return nil, err
	}
	items, err := listRolePricingGroups(ctx, q)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return items, nil
}
