package orders

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

func strPtr(v string) *string { return &v }

// article creates a part article with the given sale price (nil for none) and
// `stock` pieces received for `value` in total (loose, in storage).
func (f *fixture) article(t *testing.T, salePrice *string, stock, value string) uuid.UUID {
	t.Helper()
	typ, e := f.jobs.CreateMaterialType(t.Context(), f.p, "Parts "+newID().String(), "part", "piece", nil, nil)
	if e != nil {
		t.Fatal(e)
	}
	m, e := f.jobs.CreateMaterial(t.Context(), f.p, machinelogbook.MaterialInput{Name: "Screw " + newID().String(), MaterialTypeID: typ.ID, SalePrice: salePrice}, nil)
	if e != nil {
		t.Fatal(e)
	}
	if stock != "" {
		if _, e = f.jobs.AddPurchase(t.Context(), f.p, m.ID, m.InventoryVersion, stock, value, time.Now(), nil, nil, nil, nil); e != nil {
			t.Fatal(e)
		}
	}
	return m.ID
}

func (f *fixture) balance(t *testing.T, material uuid.UUID) (quantity, value string) {
	t.Helper()
	if e := f.pool.QueryRow(t.Context(), "SELECT quantity::text, inventory_value::text FROM material_balances WHERE material_id=$1", material).Scan(&quantity, &value); e != nil {
		t.Fatal(e)
	}
	return
}

func (f *fixture) ledger(t *testing.T, material uuid.UUID, kind string) int {
	t.Helper()
	var n int
	if e := f.pool.QueryRow(t.Context(), "SELECT count(*) FROM inventory_transactions WHERE material_id=$1 AND kind=$2", material, kind).Scan(&n); e != nil {
		t.Fatal(e)
	}
	return n
}

func (f *fixture) emptyDraft(t *testing.T) Order {
	t.Helper()
	o, e := f.s.Create(t.Context(), f.p, OrderDraftInput{Customer: &OrderCustomer{Kind: "organization", ID: f.organization}, FulfillmentMode: "immediate"}, &f.request)
	if e != nil {
		t.Fatal(e)
	}
	return o
}

func (f *fixture) addArticle(t *testing.T, o Order, material uuid.UUID, quantity, price string) Order {
	t.Helper()
	o, e := f.s.ChangeItem(t.Context(), f.p, o.ID, uuid.Nil, OrderItemInput{Kind: "inventory_item", MaterialID: material, Quantity: quantity, UnitPrice: price, ExpectedVersion: o.Version}, "add", &f.request)
	if e != nil {
		t.Fatal(e)
	}
	return o
}

func TestInventoryItemsAreAddedAndAuthorized(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	priced := f.article(t, strPtr("2.50"), "10", "20")
	unpriced := f.article(t, nil, "10", "20")
	o := f.emptyDraft(t)

	o = f.addArticle(t, o, priced, "3", "")
	item := o.Items[0]
	if item.Kind != "inventory_item" || item.UnitPrice != "2.5" || item.Amount != "7.50" || item.Unit != "piece" || item.SourceMaterialID == nil || *item.SourceMaterialID != priced || item.Description == "" || item.Snapshot != nil {
		t.Fatalf("default sale price: %+v", item)
	}
	o = f.addArticle(t, o, priced, "3", "1.333333")
	if o.Items[1].Amount != "4.00" || o.TotalAmount != "11.50" {
		t.Fatalf("explicit price rounds half-up to cents: %+v", o)
	}
	// Prices may be zero; nothing is booked before finalization.
	o = f.addArticle(t, o, unpriced, "1", "0")
	if q, v := f.balance(t, priced); q != "10.000000" || v != "20.000000" || f.ledger(t, priced, "order_sale") != 0 {
		t.Fatalf("draft touched stock: %s %s", q, v)
	}

	add := func(who authorization.Principal, in OrderItemInput) error {
		in.ExpectedVersion = o.Version
		_, e := f.s.ChangeItem(ctx, who, o.ID, uuid.Nil, in, "add", nil)
		return e
	}
	if e := add(f.p, OrderItemInput{Kind: "inventory_item", MaterialID: unpriced, Quantity: "1"}); !apperror.IsCode(e, "sale_price_required") {
		t.Fatalf("missing price: %v", e)
	}
	if e := add(f.p, OrderItemInput{Kind: "inventory_item", MaterialID: priced, Quantity: "0"}); !apperror.IsCode(e, "validation_failed") {
		t.Fatalf("zero quantity: %v", e)
	}
	if e := add(f.p, OrderItemInput{Kind: "inventory_item", Quantity: "1"}); !apperror.IsCode(e, "validation_failed") {
		t.Fatalf("missing article: %v", e)
	}
	if e := add(f.p, OrderItemInput{Kind: "inventory_item", MaterialID: newID(), Quantity: "1"}); !apperror.IsCode(e, "not_found") {
		t.Fatalf("unknown article: %v", e)
	}
	// Both permissions are needed.
	writerOnly := f.principal(t, authorization.OrdersRead, authorization.OrdersWrite)
	if e := add(writerOnly, OrderItemInput{Kind: "inventory_item", MaterialID: priced, Quantity: "1"}); !apperror.IsCode(e, "permission_denied") {
		t.Fatalf("without inventory.read: %v", e)
	}
	readerOnly := f.principal(t, authorization.OrdersRead, authorization.InventoryRead)
	if e := add(readerOnly, OrderItemInput{Kind: "inventory_item", MaterialID: priced, Quantity: "1"}); !apperror.IsCode(e, "permission_denied") {
		t.Fatalf("without orders.write: %v", e)
	}
	both := f.principal(t, authorization.OrdersRead, authorization.OrdersWrite, authorization.InventoryRead)
	if e := add(both, OrderItemInput{Kind: "inventory_item", MaterialID: priced, Quantity: "1"}); e != nil {
		t.Fatalf("with both: %v", e)
	}
	o, e := f.s.Get(ctx, f.p, o.ID)
	if e != nil {
		t.Fatal(e)
	}
	// Editing replaces the row like a manual item; removing keeps history.
	o, e = f.s.ChangeItem(ctx, f.p, o.ID, o.Items[0].ID, OrderItemInput{Kind: "inventory_item", MaterialID: priced, Quantity: "2", ExpectedVersion: o.Version}, "update", nil)
	if e != nil || o.Items[0].RemovedAt == nil || o.Items[len(o.Items)-1].Amount != "5.00" {
		t.Fatalf("edit: %v %+v", e, o.Items)
	}
	// Inactive articles are refused.
	if _, e = f.pool.Exec(ctx, "UPDATE materials SET active=false WHERE id=$1", unpriced); e != nil {
		t.Fatal(e)
	}
	if e = add(f.p, OrderItemInput{Kind: "inventory_item", MaterialID: unpriced, Quantity: "1", UnitPrice: "1"}); !apperror.IsCode(e, "article_inactive") {
		t.Fatalf("inactive: %v", e)
	}
	// Only drafts take items.
	final := f.emptyDraft(t)
	final = f.addArticle(t, final, priced, "1", "")
	final, e = f.s.Command(ctx, f.p, final.ID, cmd(final), "finalize", nil)
	if e != nil {
		t.Fatal(e)
	}
	_, e = f.s.ChangeItem(ctx, f.p, final.ID, uuid.Nil, OrderItemInput{Kind: "inventory_item", MaterialID: priced, Quantity: "1", ExpectedVersion: final.Version}, "add", nil)
	wantCode(t, e, "order_not_draft")
}

func TestFinalizationConsumesLooseStockAtAverageCost(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	material := f.article(t, strPtr("3"), "10", "20")
	o := f.emptyDraft(t)
	o = f.addArticle(t, o, material, "4", "")
	o, e := f.s.Command(ctx, f.p, o.ID, cmd(o), "finalize", nil)
	if e != nil {
		t.Fatal(e)
	}
	// An operator who may only finalize orders needs no inventory permission.
	if q, v := f.balance(t, material); q != "6.000000" || v != "12.000000" {
		t.Fatalf("balance after sale: %s %s", q, v)
	}
	var qty, value, cost string
	var itemID uuid.UUID
	var version int64
	if e = f.pool.QueryRow(ctx, "SELECT quantity_delta::text, inventory_value_delta::text, unit_acquisition_cost::text, order_item_id FROM inventory_transactions WHERE material_id=$1 AND kind='order_sale'", material).Scan(&qty, &value, &cost, &itemID); e != nil {
		t.Fatal(e)
	}
	if qty != "-4.000000" || value != "-8.000000" || cost != "2.000000" || itemID != o.Items[0].ID {
		t.Fatalf("ledger: %s %s %s %s", qty, value, cost, itemID)
	}
	if e = f.pool.QueryRow(ctx, "SELECT version FROM material_balances WHERE material_id=$1", material).Scan(&version); e != nil || version < 3 {
		t.Fatalf("inventory version %d %v", version, e)
	}
	var audits int
	if e = f.pool.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE action='order.finalized' AND resource_id=$1", o.ID).Scan(&audits); e != nil || audits != 1 {
		t.Fatalf("audit: %d %v", audits, e)
	}

	// A second order sells the rest at the new average (same 2.00 per piece).
	next := f.emptyDraft(t)
	next = f.addArticle(t, next, material, "6", "3")
	if _, e = f.s.Command(ctx, f.p, next.ID, cmd(next), "finalize", nil); e != nil {
		t.Fatal(e)
	}
	if q, v := f.balance(t, material); q != "0.000000" || v != "0.000000" {
		t.Fatalf("empty stock: %s %s", q, v)
	}
}

func TestFinalizeNeedsOnlyOrderPermissions(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	material := f.article(t, strPtr("3"), "10", "20")
	o := f.addArticle(t, f.emptyDraft(t), material, "1", "")
	finalizer := f.principal(t, authorization.OrdersRead, authorization.OrdersFinalize)
	if _, e := f.s.Command(ctx, finalizer, o.ID, cmd(o), "finalize", nil); e != nil {
		t.Fatalf("finalize without inventory permissions: %v", e)
	}
}

func TestInsufficientLooseStockFailsTheWholeFinalization(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	plenty := f.article(t, strPtr("1"), "100", "100")
	short := f.article(t, strPtr("1"), "10", "20")
	// Stock that only exists on a spool is not loose.
	filamentType, e := f.jobs.CreateMaterialType(ctx, f.p, "PETG "+newID().String(), "filament", "g", []string{"fdm_printing"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	filament, e := f.jobs.CreateMaterial(ctx, f.p, machinelogbook.MaterialInput{Name: "Spooled " + newID().String(), MaterialTypeID: filamentType.ID, SalePrice: strPtr("1")}, nil)
	if e != nil {
		t.Fatal(e)
	}
	spooled := filament.ID
	if _, e = f.jobs.ReceiveStock(ctx, f.p, machinelogbook.ReceiptInput{MaterialID: &spooled, ExpectedInventoryVersion: filament.InventoryVersion, PackageCount: 1, PackageSize: strPtr("1000"), TotalPrice: "20.00", OccurredAt: time.Now().Add(-time.Minute), Placement: &machinelogbook.ReceiptPlacement{Mode: machinelogbook.PlacementNewSpools}}, nil); e != nil {
		t.Fatal(e)
	}

	o := f.emptyDraft(t)
	o = f.addArticle(t, o, plenty, "5", "")
	o = f.addArticle(t, o, short, "11", "")
	_, e = f.s.Command(ctx, f.p, o.ID, cmd(o), "finalize", nil)
	wantCode(t, e, "insufficient_stock")
	details := e.(*apperror.Error).Details
	if details["materialId"] != short.String() || details["available"] != "10" {
		t.Fatalf("details: %v", details)
	}
	if e.(*apperror.Error).HTTPStatus != 409 {
		t.Fatal(e)
	}
	got, err := f.s.Get(ctx, f.p, o.ID)
	if err != nil || got.Status != "draft" {
		t.Fatalf("order must stay a draft: %v %+v", err, got.Status)
	}
	if q, _ := f.balance(t, plenty); q != "100.000000" || f.ledger(t, plenty, "order_sale") != 0 || f.ledger(t, short, "order_sale") != 0 {
		t.Fatal("a failed finalization left ledger rows or consumed stock")
	}

	o = f.addArticle(t, f.emptyDraft(t), spooled, "1", "")
	_, e = f.s.Command(ctx, f.p, o.ID, cmd(o), "finalize", nil)
	wantCode(t, e, "insufficient_stock")
	if e.(*apperror.Error).Details["available"] != "0" {
		t.Fatalf("spool stock counted as loose: %v", e.(*apperror.Error).Details)
	}
	// Checkout shares the path.
	_, e = f.s.Command(ctx, f.p, o.ID, cmd(o), "checkout", nil)
	wantCode(t, e, "insufficient_stock")
}

func TestFinalizeRetryDoesNotBookTwice(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	material := f.article(t, strPtr("3"), "10", "20")
	o := f.addArticle(t, f.emptyDraft(t), material, "4", "")
	command := cmd(o)
	first, e := f.s.Command(ctx, f.p, o.ID, command, "finalize", nil)
	if e != nil {
		t.Fatal(e)
	}
	retry, e := f.s.Command(ctx, f.p, o.ID, command, "finalize", nil)
	if e != nil || retry.ID != first.ID || retry.Status != "finalized" {
		t.Fatalf("retry: %v %+v", e, retry)
	}
	if f.ledger(t, material, "order_sale") != 1 {
		t.Fatal("retry booked the sale twice")
	}
	if q, _ := f.balance(t, material); q != "6.000000" {
		t.Fatal(q)
	}
	// The ledger also refuses a second sale for the same item.
	if _, e = f.pool.Exec(ctx, `INSERT INTO inventory_transactions(id,material_id,kind,quantity_delta,unit_acquisition_cost,inventory_value_delta,occurred_at,order_item_id)
		VALUES($1,$2,'order_sale',-1,2,-2,now(),$3)`, newID(), material, first.Items[0].ID); e == nil {
		t.Fatal("duplicate order_sale accepted")
	}
}

func TestReversalRestocksExactlyAndReplacementConsumesAgain(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	// 7 pieces for 10.00: the average cost 1.428571... does not divide evenly.
	material := f.article(t, strPtr("3"), "7", "10")
	o := f.addArticle(t, f.emptyDraft(t), material, "3", "")
	o, e := f.s.Command(ctx, f.p, o.ID, cmd(o), "finalize", nil)
	if e != nil {
		t.Fatal(e)
	}
	soldQuantity, soldValue := f.balance(t, material)
	if soldQuantity != "4.000000" {
		t.Fatal(soldQuantity)
	}
	var saleValue string
	if e = f.pool.QueryRow(ctx, "SELECT inventory_value_delta::text FROM inventory_transactions WHERE material_id=$1 AND kind='order_sale'", material).Scan(&saleValue); e != nil {
		t.Fatal(e)
	}

	// Replacement flow: the original is reversed (restocked) and the
	// replacement consumes on its own finalization.
	next, e := f.s.Command(ctx, f.p, o.ID, cmd(o), "replacements", nil)
	if e != nil {
		t.Fatal(e)
	}
	if len(next.Items) != 1 || next.Items[0].Kind != "inventory_item" || next.Items[0].SourceMaterialID == nil || *next.Items[0].SourceMaterialID != material {
		t.Fatalf("replacement draft: %+v", next.Items)
	}
	if q, _ := f.balance(t, material); q != soldQuantity {
		t.Fatal("a replacement draft touched stock")
	}
	replace := cmd(o)
	replace.ReplacementOrderID, replace.ExpectedReplacementVersion, replace.Reason = next.ID, next.Version, "Correction"
	next, e = f.s.Command(ctx, f.p, o.ID, replace, "replace", nil)
	if e != nil {
		t.Fatal(e)
	}
	if f.ledger(t, material, "order_sale") != 2 || f.ledger(t, material, "order_sale_reversal") != 1 {
		t.Fatal("ledger rows of the replacement")
	}
	if q, v := f.balance(t, material); q != soldQuantity || v != soldValue {
		t.Fatalf("original restocked then replacement consumed again: %s %s", q, v)
	}

	// Reversing the replacement restocks exactly what it removed.
	if _, e = f.s.Command(ctx, f.p, next.ID, OrderCommand{OperationKey: newID(), ExpectedVersion: next.Version, Reason: "Returned"}, "reverse", nil); e != nil {
		t.Fatal(e)
	}
	if q, v := f.balance(t, material); q != "7.000000" || v != "10.000000" {
		t.Fatalf("reversal restock: %s %s", q, v)
	}
	var qty, value, itemID = "", "", uuid.Nil
	if e = f.pool.QueryRow(ctx, `SELECT quantity_delta::text, inventory_value_delta::text, order_item_id FROM inventory_transactions
		WHERE material_id=$1 AND kind='order_sale_reversal' AND order_item_id=$2`, material, next.Items[0].ID).Scan(&qty, &value, &itemID); e != nil {
		t.Fatal(e)
	}
	if qty != "3.000000" || value != saleValue[1:] || itemID != next.Items[0].ID {
		t.Fatalf("reversal row: %s %s (sale %s)", qty, value, saleValue)
	}
	var restored string
	if e = f.pool.QueryRow(ctx, `SELECT (s.inventory_value_delta + r.inventory_value_delta)::text FROM inventory_transactions s JOIN inventory_transactions r ON r.order_item_id=s.order_item_id AND r.kind='order_sale_reversal'
		WHERE s.kind='order_sale' AND s.order_item_id=$1`, next.Items[0].ID).Scan(&restored); e != nil || restored != "0.000000" {
		t.Fatalf("value not restored exactly: %s %v", restored, e)
	}
	// Reversed orders are not reversed again.
	if _, e = f.s.Command(ctx, f.p, next.ID, OrderCommand{OperationKey: newID(), ExpectedVersion: next.Version + 1, Reason: "Again"}, "reverse", nil); e == nil {
		t.Fatal("second reversal accepted")
	}
	if f.ledger(t, material, "order_sale_reversal") != 2 {
		t.Fatal("reversal rows")
	}
}

func TestMixedOrderTotals(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	filament := f.stockedMaterial(t, "PLA mixed")
	start := time.Now().UTC().Add(-3 * time.Hour).Truncate(time.Second)
	job, e := f.jobs.CreateManualJob(ctx, f.p, machinelogbook.JobInput{MachineID: f.machine, StartsAt: start, EndsAt: start.Add(time.Hour), Customer: machinelogbook.PartyReference{Kind: "organization", ID: f.organization}, OperatorPersonID: f.person, Outcome: "successful", Usages: []machinelogbook.UsageInput{{MaterialID: filament, Quantity: "30"}}}, nil)
	if e != nil {
		t.Fatal(e)
	}
	material := f.article(t, strPtr("2.50"), "10", "20")
	o := f.draft(t, true, "5")
	o, e = f.s.ChangeItem(ctx, f.p, o.ID, uuid.Nil, OrderItemInput{Kind: "machine_job", MachineJobID: job.ID, ExpectedJobVersion: job.Version, ExpectedVersion: o.Version}, "add", nil)
	if e != nil {
		t.Fatal(e)
	}
	o = f.addArticle(t, o, material, "3", "")
	if len(o.Items) != 3 {
		t.Fatal(o.Items)
	}
	var jobAmount string
	for _, item := range o.Items {
		if item.Kind == "machine_job" {
			jobAmount = item.Amount
		}
	}
	// 5.00 manual + 7.50 stock + the job charge.
	var want string
	if e = f.pool.QueryRow(ctx, "SELECT (12.50 + $1::numeric)::text", jobAmount).Scan(&want); e != nil {
		t.Fatal(e)
	}
	if o.TotalAmount != want {
		t.Fatalf("draft total %s, want %s", o.TotalAmount, want)
	}
	o, e = f.s.Command(ctx, f.p, o.ID, cmd(o), "finalize", nil)
	if e != nil || o.TotalAmount != want {
		t.Fatalf("finalized total %s, want %s (%v)", o.TotalAmount, want, e)
	}
	if q, _ := f.balance(t, material); q != "7.000000" {
		t.Fatal(q)
	}
	// Summaries of an external invoice request carry the article name.
	var name string
	if e = f.pool.QueryRow(ctx, "SELECT name FROM materials WHERE id=$1", material).Scan(&name); e != nil {
		t.Fatal(e)
	}
	for _, item := range o.Items {
		if item.Kind == "inventory_item" && item.Description != name {
			t.Fatalf("description %q, want %q", item.Description, name)
		}
	}
}

func TestOrderSaleLedgerReferenceIsImmutable(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	material := f.article(t, strPtr("3"), "10", "20")
	o := f.addArticle(t, f.emptyDraft(t), material, "2", "")
	other := f.addArticle(t, f.emptyDraft(t), material, "1", "")
	another := f.article(t, strPtr("1"), "1", "1")
	o, e := f.s.Command(ctx, f.p, o.ID, cmd(o), "finalize", nil)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.pool.Exec(ctx, "UPDATE inventory_transactions SET order_item_id=$1 WHERE order_item_id=$2", other.Items[0].ID, o.Items[0].ID); e == nil {
		t.Fatal("order_item_id was re-pointed")
	}
	if _, e = f.pool.Exec(ctx, "UPDATE inventory_transactions SET quantity_delta=-1 WHERE order_item_id=$1", o.Items[0].ID); e == nil {
		t.Fatal("sale quantity was changed")
	}
	if _, e = f.pool.Exec(ctx, "UPDATE inventory_transactions SET kind='manual_consumption' WHERE order_item_id=$1", o.Items[0].ID); e == nil {
		t.Fatal("sale kind was changed")
	}
	if _, e = f.pool.Exec(ctx, "DELETE FROM inventory_transactions WHERE order_item_id=$1", o.Items[0].ID); e == nil {
		t.Fatal("sale was deleted")
	}
	if _, e = f.pool.Exec(ctx, "UPDATE order_items SET source_material_id=$1 WHERE id=$2", another, o.Items[0].ID); e == nil {
		t.Fatal("finalized item content changed")
	}
	// The reference may only be detached (item deletion with its order).
	if _, e = f.pool.Exec(ctx, "UPDATE inventory_transactions SET order_item_id=NULL WHERE order_item_id=$1", o.Items[0].ID); e != nil {
		t.Fatalf("detaching: %v", e)
	}
	if _, e = f.pool.Exec(ctx, "UPDATE inventory_transactions SET order_item_id=$1 WHERE kind='order_sale' AND order_item_id IS NULL", o.Items[0].ID); e == nil {
		t.Fatal("a detached reference was re-attached")
	}
	// Other kinds never carry an order item.
	if _, e = f.pool.Exec(ctx, `INSERT INTO inventory_transactions(id,material_id,kind,quantity_delta,unit_acquisition_cost,inventory_value_delta,total_purchase_price,occurred_at,order_item_id)
		VALUES($1,$2,'purchase',1,1,1,1,now(),$3)`, newID(), material, other.Items[0].ID); e == nil {
		t.Fatal("purchase with order item accepted")
	}
}

func TestLedgerShowsOrderAndConsumptionIncludesSales(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	material := f.article(t, strPtr("2"), "10", "20")
	o := f.addArticle(t, f.emptyDraft(t), material, "3", "")
	o, e := f.s.Command(ctx, f.p, o.ID, cmd(o), "finalize", nil)
	if e != nil {
		t.Fatal(e)
	}
	m, e := f.jobs.GetMaterial(ctx, f.p, material)
	if e != nil || m.RecentConsumption != "3" {
		t.Fatalf("sales count as consumption: %q %v", m.RecentConsumption, e)
	}
	if _, e = f.s.Command(ctx, f.p, o.ID, OrderCommand{OperationKey: newID(), ExpectedVersion: o.Version, Reason: "Returned"}, "reverse", nil); e != nil {
		t.Fatal(e)
	}
	m, e = f.jobs.GetMaterial(ctx, f.p, material)
	if e != nil || m.RecentConsumption != "0" {
		t.Fatalf("reversal nets the sale out: %q %v", m.RecentConsumption, e)
	}
	items, _, e := f.jobs.ListMaterialTransactions(ctx, f.p, material, 1, 50)
	if e != nil {
		t.Fatal(e)
	}
	seen := map[string]bool{}
	for _, tx := range items {
		seen[tx.Kind] = true
		switch tx.Kind {
		case "order_sale", "order_sale_reversal":
			if tx.OrderID == nil || *tx.OrderID != o.ID || tx.OrderReference == nil || *tx.OrderReference != o.Reference {
				t.Fatalf("%s without its order: %+v", tx.Kind, tx)
			}
		default:
			if tx.OrderID != nil || tx.OrderReference != nil {
				t.Fatalf("%s must not carry an order: %+v", tx.Kind, tx)
			}
		}
	}
	if !seen["order_sale"] || !seen["order_sale_reversal"] || !seen["purchase"] {
		t.Fatalf("ledger kinds: %v", seen)
	}
}
