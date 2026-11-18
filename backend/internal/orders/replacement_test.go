package orders

import (
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
)

func TestReplacementDraftStartDiscardAndCommit(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	o := f.draft(t, true, "10")
	o, e := f.s.Command(ctx, f.p, o.ID, cmd(o), "finalize", &f.request)
	if e != nil {
		t.Fatal(e)
	}

	next, e := f.s.Command(ctx, f.p, o.ID, cmd(o), "replacements", &f.request)
	if e != nil {
		t.Fatal(e)
	}
	if next.Status != "draft" || next.ReplacesOrderID == nil || *next.ReplacesOrderID != o.ID ||
		next.Customer == nil || next.Customer.ID != f.organization || len(next.Items) != 1 ||
		next.Items[0].Amount != "10.00" {
		t.Fatalf("replacement not linked and prefilled: %+v", next)
	}
	o, e = f.s.Get(ctx, f.p, o.ID)
	if e != nil {
		t.Fatal(e)
	}
	if o.PendingReplacementOrderID == nil || *o.PendingReplacementOrderID != next.ID ||
		o.PendingReplacementOrderReference == nil || *o.PendingReplacementOrderReference != next.Reference {
		t.Fatalf("original does not show the replacement in progress: %+v", o)
	}
	_, e = f.s.Command(ctx, f.p, o.ID, cmd(o), "replacements", &f.request)
	wantCode(t, e, "replacement_in_progress")
	_, e = f.s.Command(ctx, f.p, next.ID, cmd(next), "cancel", &f.request)
	wantCode(t, e, "replacement_discard_required")

	other := f.draft(t, false, "5")
	_, e = f.s.Command(ctx, f.p, other.ID, cmd(other), "discard", &f.request)
	wantCode(t, e, "order_not_replacement")
	_, e = f.s.Command(ctx, f.p, o.ID, cmd(o), "discard", &f.request)
	wantCode(t, e, "order_not_replacement")

	discard := cmd(next)
	o, e = f.s.Command(ctx, f.p, next.ID, discard, "discard", &f.request)
	if e != nil {
		t.Fatal(e)
	}
	if o.Status != "finalized" || o.PendingReplacementOrderID != nil {
		t.Fatalf("discard must answer the original without a replacement in progress: %+v", o)
	}
	if retry, e := f.s.Command(ctx, f.p, next.ID, discard, "discard", &f.request); e != nil || retry.ID != o.ID {
		t.Fatalf("retried discard: %+v %v", retry, e)
	}
	_, e = f.s.Get(ctx, f.p, next.ID)
	wantCode(t, e, "not_found")
	var rows, audits int
	if e = f.pool.QueryRow(ctx, "SELECT count(*) FROM order_items WHERE order_id=$1", next.ID).Scan(&rows); e != nil ||
		rows != 0 {
		t.Fatalf("discarded items kept: %d %v", rows, e)
	}
	if e = f.pool.QueryRow(
		ctx,
		"SELECT count(*) FROM audit_events WHERE action='order.replacement_discarded' AND resource_id=$1",
		o.ID,
	).Scan(&audits); e != nil || audits != 1 {
		t.Fatalf("discard audit: %d %v", audits, e)
	}

	next, e = f.s.Command(ctx, f.p, o.ID, cmd(o), "replacements", &f.request)
	if e != nil {
		t.Fatal(e)
	}
	o, e = f.s.Get(ctx, f.p, o.ID)
	if e != nil {
		t.Fatal(e)
	}
	replace := cmd(o)
	replace.ReplacementOrderID = next.ID
	replace.ExpectedReplacementVersion = next.Version
	replace.Reason = "Correct service description"
	committed, e := f.s.Command(ctx, f.p, o.ID, replace, "replace", &f.request)
	if e != nil {
		t.Fatal(e)
	}
	if committed.ID != next.ID || committed.Status != "finalized" {
		t.Fatalf("replacement not committed: %+v", committed)
	}
	o, e = f.s.Get(ctx, f.p, o.ID)
	if e != nil {
		t.Fatal(e)
	}
	if o.Status != "reversed" || o.PendingReplacementOrderID != nil || o.ReplacedByOrderID == nil ||
		*o.ReplacedByOrderID != next.ID {
		t.Fatalf("original after commit: %+v", o)
	}
	_, e = f.s.Command(ctx, f.p, committed.ID, cmd(committed), "discard", &f.request)
	wantCode(t, e, "order_not_draft")
	_, e = f.s.Command(ctx, f.p, o.ID, cmd(o), "replacements", &f.request)
	wantCode(t, e, "order_already_replaced")
}

func TestReplacementDraftPermissions(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	o := f.draft(t, true, "10")
	o, e := f.s.Command(ctx, f.p, o.ID, cmd(o), "finalize", &f.request)
	if e != nil {
		t.Fatal(e)
	}
	reader := f.principal(t, authorization.OrdersRead)
	_, e = f.s.Command(ctx, reader, o.ID, cmd(o), "replacements", &f.request)
	wantCode(t, e, "permission_denied")

	unread := f.principal(t, authorization.OrdersWrite)
	_, e = f.s.Command(ctx, unread, o.ID, cmd(o), "replacements", &f.request)
	wantCode(t, e, "permission_denied")

	writer := f.principal(t, authorization.OrdersRead, authorization.OrdersWrite)
	next, e := f.s.Command(ctx, writer, o.ID, cmd(o), "replacements", &f.request)
	if e != nil {
		t.Fatalf("orders.write starts a replacement: %v", e)
	}
	_, e = f.s.Command(ctx, reader, next.ID, cmd(next), "discard", &f.request)
	wantCode(t, e, "permission_denied")
	_, e = f.s.Command(ctx, unread, next.ID, cmd(next), "discard", &f.request)
	wantCode(t, e, "permission_denied")
	o, e = f.s.Get(ctx, f.p, o.ID)
	if e != nil {
		t.Fatal(e)
	}
	replace := cmd(o)
	replace.ReplacementOrderID = next.ID
	replace.ExpectedReplacementVersion = next.Version
	replace.Reason = "Wrong item"
	_, e = f.s.Command(ctx, writer, o.ID, replace, "replace", &f.request)
	wantCode(t, e, "permission_denied")
	if _, e = f.s.Command(ctx, writer, next.ID, cmd(next), "discard", &f.request); e != nil {
		t.Fatalf("orders.write discards a replacement: %v", e)
	}
}
