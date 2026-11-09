package machinelogbook

import (
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

// The four inventory permissions gate disjoint groups of operations: a holder of one must not be able to use the
// operations of the other three.
func TestInventoryPermissionsGateTheirOwnOperations(t *testing.T) {
	f := newSpoolFixture(t)
	ctx := t.Context()
	all := []authorization.Permission{
		authorization.InventoryArticlesManage,
		authorization.InventoryReceive,
		authorization.InventoryConsume,
		authorization.InventoryCorrect,
	}
	only := func(permission authorization.Permission) authorization.Principal {
		return restrictedPrincipal(t, f.pool, authorization.InventoryRead, permission)
	}
	without := func(permission authorization.Permission) authorization.Principal {
		granted := []authorization.Permission{authorization.InventoryRead}
		for _, other := range all {
			if other != permission {
				granted = append(granted, other)
			}
		}
		return restrictedPrincipal(t, f.pool, granted...)
	}
	denied := func(t *testing.T, err error) {
		t.Helper()
		if !apperror.IsCode(err, "permission_denied") {
			t.Fatalf("expected permission_denied, got %v", err)
		}
	}
	m := f.material(t, "1000")
	spool := f.spool(t, m, "500")
	m = f.refresh(t, m.ID)

	t.Run("articles.manage creates articles and spools", func(t *testing.T) {
		input := MaterialInput{Name: f.unique("Permission PLA"), MaterialTypeID: f.typeID}
		_, err := f.s.CreateMaterial(ctx, without(authorization.InventoryArticlesManage), input, &f.request)
		denied(t, err)
		if _, err = f.s.CreateMaterial(ctx, only(authorization.InventoryArticlesManage), input, &f.request); err != nil {
			t.Fatalf("create article with inventory.articles.manage: %v", err)
		}
		spoolInput := FilamentSpoolInput{
			MaterialID:               m.ID,
			InitialNetWeightG:        "100",
			StockMode:                StockModeExistingStock,
			OccurredAt:               f.now,
			ExpectedInventoryVersion: m.InventoryVersion,
		}
		spoolsManager := restrictedPrincipal(t, f.pool, authorization.InventoryRead, authorization.FilamentSpoolsManage,
			authorization.InventoryReceive, authorization.InventoryConsume, authorization.InventoryCorrect)
		_, err = f.s.CreateFilamentSpool(ctx, spoolsManager, spoolInput, &f.request)
		denied(t, err)
	})

	t.Run("receive books purchases", func(t *testing.T) {
		current := f.refresh(t, m.ID)
		_, err := f.s.AddPurchase(ctx, without(authorization.InventoryReceive), m.ID, current.InventoryVersion, "10", "1",
			f.now, nil, nil, nil, &f.request)
		denied(t, err)
		if _, err = f.s.AddPurchase(ctx, only(authorization.InventoryReceive), m.ID, current.InventoryVersion, "10", "1",
			f.now, nil, nil, nil, &f.request); err != nil {
			t.Fatalf("purchase with inventory.receive: %v", err)
		}
		_, err = f.s.ReceiveStock(ctx, without(authorization.InventoryReceive), ReceiptInput{MaterialID: &m.ID}, &f.request)
		denied(t, err)
	})

	t.Run("consume records consumption and moves stock between spools", func(t *testing.T) {
		current := f.refresh(t, m.ID)
		_, err := f.s.RecordConsumption(ctx, without(authorization.InventoryConsume), m.ID, current.InventoryVersion,
			"5", f.now, false, nil, nil, &f.request)
		denied(t, err)
		_, err = f.s.TransferSpoolStock(ctx, without(authorization.InventoryConsume), m.ID, current.InventoryVersion,
			nil, &spool.ID, "1", f.now, nil, &f.request)
		denied(t, err)
		_, err = f.s.ConsumeFilamentSpool(ctx, without(authorization.InventoryConsume), spool.ID,
			current.InventoryVersion, f.get(t, spool.ID).Version, "1", f.now, false, nil, nil, &f.request)
		denied(t, err)
		if _, err = f.s.RecordConsumption(ctx, only(authorization.InventoryConsume), m.ID, current.InventoryVersion,
			"5", f.now, false, nil, nil, &f.request); err != nil {
			t.Fatalf("consumption with inventory.consume: %v", err)
		}
	})

	t.Run("correct fixes stock and retires spools", func(t *testing.T) {
		current := f.refresh(t, m.ID)
		_, err := f.s.CorrectStock(ctx, without(authorization.InventoryCorrect), m.ID, current.InventoryVersion, "700",
			nil, f.now, "recount", nil, &f.request)
		denied(t, err)
		_, err = f.s.MarkEmpty(ctx, without(authorization.InventoryCorrect), m.ID, current.InventoryVersion, f.now, nil,
			&f.request)
		denied(t, err)
		withSpools := func(permissions ...authorization.Permission) authorization.Principal {
			return restrictedPrincipal(t, f.pool,
				append([]authorization.Permission{authorization.InventoryRead, authorization.FilamentSpoolsManage},
					permissions...)...)
		}
		_, err = f.s.RetireFilamentSpool(ctx, withSpools(authorization.InventoryArticlesManage,
			authorization.InventoryReceive, authorization.InventoryConsume), spool.ID, f.get(t, spool.ID).Version,
			SpoolRetiredDiscarded, &f.request)
		denied(t, err)
		if _, err = f.s.CorrectStock(ctx, only(authorization.InventoryCorrect), m.ID, current.InventoryVersion, "700",
			nil, f.now, "recount", nil, &f.request); err != nil {
			t.Fatalf("correction with inventory.correct: %v", err)
		}
		retired, err := f.s.RetireFilamentSpool(ctx, withSpools(authorization.InventoryCorrect), spool.ID,
			f.get(t, spool.ID).Version, SpoolRetiredDiscarded, &f.request)
		if err != nil {
			t.Fatalf("retire with inventory.correct: %v", err)
		}
		_, err = f.s.RestoreFilamentSpool(ctx, withSpools(authorization.InventoryArticlesManage,
			authorization.InventoryReceive, authorization.InventoryConsume), spool.ID, retired.Version, &f.request)
		denied(t, err)
		if _, err = f.s.RestoreFilamentSpool(ctx, withSpools(authorization.InventoryCorrect), spool.ID, retired.Version,
			&f.request); err != nil {
			t.Fatalf("restore with inventory.correct: %v", err)
		}
	})
}
