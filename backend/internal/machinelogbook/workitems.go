package machinelogbook

import (
	"context"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/google/uuid"
)

// WorkItemBilling is the billing state of a job. The order fields are order
// data and are only filled for callers allowed to read orders.
type WorkItemBilling struct {
	State          string
	OrderID        *uuid.UUID
	OrderReference *string
}

// WorkItem is one row of the unified table: a machine job, or a recorded run
// that no job is assigned to.
type WorkItem struct {
	Kind                   string
	ID                     uuid.UUID
	DisplayID              string
	Title, FileName        *string
	RunCount               int
	MachineID              uuid.UUID
	MachineName            string
	Customer               *BillingParty
	Operator               *Operator
	Status, Source         string
	StartedAt              time.Time
	EndsAt, EstimatedEndAt *time.Time
	ProgressPercent        *int
	EffectivePrice         *string
	Billing                *WorkItemBilling
	Consumption            WorkItemConsumption
	Version                int64
}

// WorkItemConsumption summarises what the runs of a work item consumed, per
// material type and unit, and their run measures.
type WorkItemConsumption struct {
	Materials []ConsumedMaterial
	Measures  RunMeasures
}

type ConsumedMaterial struct {
	MaterialTypeName, Unit, Quantity string
}

type WorkItemFilters struct {
	Search                     string
	Statuses, Sources, Billing []string
	MachineIDs, MaterialIDs    []uuid.UUID
	CustomerID, OperatorID     *uuid.UUID
	From, To                   *time.Time
	Sort, Direction            string
	Page, PageSize             int
}

var (
	workItemStatuses = []string{
		"running",
		"running_unassigned",
		"unassigned",
		"needs_outcome",
		"successful",
		"partial_failure",
		"failed",
		"cancelled",
	}
	workItemSources = []string{"manual", "recorded"}
	billingStates   = []string{"on_order", "order_outdated", "not_on_order", "price_incomplete", "pending"}
	workItemSorts   = []string{"startedAt", "name", "machine", "customer", "price"}
)

func containsAll(allowed, values []string) bool {
	for _, value := range values {
		found := false
		for _, candidate := range allowed {
			if candidate == value {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func nonNil[T any](values []T) []T {
	if values == nil {
		return []T{}
	}
	return values
}

func (s *Service) ListWorkItems(
	ctx context.Context,
	p authorization.Principal,
	filters WorkItemFilters,
) ([]WorkItem, int64, error) {
	if err := require(p, authorization.MachineJobsRead); err != nil {
		return nil, 0, err
	}
	offset, limit, err := pageBounds(filters.Page, filters.PageSize)
	if err != nil {
		return nil, 0, err
	}
	if filters.Sort == "" {
		filters.Sort = "startedAt"
	}
	if filters.Direction == "" {
		filters.Direction = "desc"
	}
	if !containsAll(
		workItemSorts,
		[]string{filters.Sort},
	) || (filters.Direction != "asc" && filters.Direction != "desc") ||
		!containsAll(workItemStatuses, filters.Statuses) ||
		!containsAll(workItemSources, filters.Sources) ||
		!containsAll(billingStates, filters.Billing) {
		return nil, 0, apperror.Invalid("unsupported work item filter or sort")
	}
	params := machinelogbookdb.ListWorkItemsParams{
		Statuses: nonNil(
			filters.Statuses,
		), MachineIds: nonNil(filters.MachineIDs), Sources: nonNil(filters.Sources), MaterialIds: nonNil(filters.MaterialIDs),
		BillingStates: nonNil(filters.Billing), CustomerID: filters.CustomerID, OperatorPersonID: filters.OperatorID,
		FromTime: pgTime(
			filters.From,
		), ToTime: pgTime(filters.To), Search: escapeLike(strings.TrimSpace(filters.Search)),
		SortKey: filters.Sort, SortDirection: filters.Direction, PageOffset: offset, PageLimit: limit,
	}
	q := machinelogbookdb.New(s.pool)
	rows, err := q.ListWorkItems(ctx, params)
	if err != nil {
		return nil, 0, err
	}
	var total int64
	if len(rows) > 0 {
		total = rows[0].Total
	} else if offset > 0 {
		// A page past the end carries no window total; ask for the first row instead.
		params.PageOffset, params.PageLimit = 0, 1
		first, err := q.ListWorkItems(ctx, params)
		if err != nil {
			return nil, 0, err
		}
		if len(first) > 0 {
			total = first[0].Total
		}
	}
	items := workItemsFromRows(rows, p.Has(authorization.OrdersRead))
	if err = attachConsumption(ctx, q, items); err != nil {
		return nil, 0, err
	}
	return items, total, nil
}

// attachConsumption fills the consumption summary of the listed items.
func attachConsumption(ctx context.Context, q *machinelogbookdb.Queries, items []WorkItem) error {
	ids := make([]uuid.UUID, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	materials, err := q.ListWorkItemMaterialTotals(ctx, ids)
	if err != nil {
		return err
	}
	measures, err := q.ListWorkItemMeasureTotals(ctx, ids)
	if err != nil {
		return err
	}
	byItem := map[uuid.UUID]*WorkItemConsumption{}
	of := func(id uuid.UUID) *WorkItemConsumption {
		if byItem[id] == nil {
			byItem[id] = &WorkItemConsumption{Materials: []ConsumedMaterial{}, Measures: RunMeasures{}}
		}
		return byItem[id]
	}
	for _, row := range materials {
		c := of(row.ItemID)
		c.Materials = append(
			c.Materials,
			ConsumedMaterial{
				MaterialTypeName: row.MaterialTypeName,
				Unit:             row.Unit,
				Quantity:         decimalString(row.Quantity),
			},
		)
	}
	for _, row := range measures {
		of(row.ItemID).Measures[row.Measure] = row.Value
	}
	for i := range items {
		if c := byItem[items[i].ID]; c != nil {
			items[i].Consumption = *c
		} else {
			items[i].Consumption = WorkItemConsumption{Materials: []ConsumedMaterial{}, Measures: RunMeasures{}}
		}
	}
	return nil
}

func workItemsFromRows(rows []machinelogbookdb.ListWorkItemsRow, includeOrder bool) []WorkItem {
	items := make([]WorkItem, 0, len(rows))
	for _, row := range rows {
		items = append(items, workItemFromRow(row, includeOrder))
	}
	return items
}

func workItemFromRow(row machinelogbookdb.ListWorkItemsRow, includeOrder bool) WorkItem {
	item := WorkItem{
		Kind:        row.Kind,
		ID:          row.ID,
		DisplayID:   row.DisplayID,
		Title:       row.Title,
		FileName:    row.FileName,
		RunCount:    int(row.RunCount),
		MachineID:   row.MachineID,
		MachineName: row.MachineName,
		Status:      row.Status,
		Source:      row.Source,
		StartedAt:   row.StartedAt.UTC(),
		EndsAt: nullableTime(
			row.EndsAt,
		),
		EstimatedEndAt: nullableTime(row.EstimatedEndAt),
		EffectivePrice: nullableDecimal(row.EffectivePrice),
		Version:        row.Version,
	}
	if row.ProgressPercent != nil {
		percent := int(*row.ProgressPercent)
		item.ProgressPercent = &percent
	}
	if row.CustomerID != nil && row.CustomerKind != nil && row.CustomerName != nil {
		party := &BillingParty{
			ID:                            *row.CustomerID,
			Kind:                          *row.CustomerKind,
			DisplayName:                   *row.CustomerName,
			OrganizationKind:              row.CustomerOrganizationKind,
			PricingGroupAssignmentVersion: row.CustomerPricingGroupAssignmentVersion,
		}
		if row.CustomerPricingGroupID != nil && row.CustomerPricingGroupName != nil {
			party.PricingGroup = &PricingGroupSummary{
				ID:   *row.CustomerPricingGroupID,
				Name: *row.CustomerPricingGroupName,
			}
		}
		item.Customer = party
	}
	if row.OperatorPersonID != nil && row.OperatorName != nil {
		item.Operator = &Operator{PersonID: *row.OperatorPersonID, DisplayName: *row.OperatorName}
	}
	if row.BillingState != nil {
		billing := &WorkItemBilling{State: *row.BillingState}
		if includeOrder {
			billing.OrderID, billing.OrderReference = row.BillingOrderID, row.BillingOrderReference
		}
		item.Billing = billing
	}
	return item
}

// countWorkItems counts the items matching a filter without loading them.
func (s *Service) countWorkItems(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	statuses, billing []string,
) (int64, error) {
	rows, err := q.ListWorkItems(
		ctx,
		machinelogbookdb.ListWorkItemsParams{
			Statuses:      nonNil(statuses),
			BillingStates: nonNil(billing),
			MachineIds:    []uuid.UUID{},
			Sources:       []string{},
			MaterialIds:   []uuid.UUID{},
			SortKey:       "startedAt",
			SortDirection: "desc",
			PageLimit:     1,
		},
	)
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	return rows[0].Total, nil
}
