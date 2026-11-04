package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// dateOf places a date of the fixed stock timeline (written for
// timelineAnchor) relative to today.
func (s *seeder) dateOf(month time.Month, day int) time.Time {
	return time.Date(timelineAnchor.Year(), month, day, 12, 0, 0, 0, s.loc).Add(s.shift).UTC()
}

func (s *seeder) mat(name string) machinelogbook.Material {
	m, err := s.ml.GetMaterial(s.ctx, s.actor, s.mats[name].id)
	check("get material", err)
	return m
}

func dnum(v string) float64 { f, _ := decimal.RequireFromString(v).Float64(); return f }

func (s *seeder) purchase(name string, qty float64, price float64, at time.Time, supplier string, qd int) {
	m := s.mat(name)
	var q string
	if qd == 0 {
		q = f1(qty)
	} else {
		q = f3(qty)
	}
	_, err := s.ml.AddPurchase(s.ctx, s.actor, m.ID, m.InventoryVersion, q, f2(price), at, ptr(supplier), nil, nil, nil)
	check("purchase "+name, err)
}

func (s *seeder) randHex(bytes int) string {
	b := make([]byte, bytes)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// nextBarcode draws from crypto/rand: barcodes are unique across runs, and
// repeated runs with the same -seed must not collide.
func (s *seeder) nextBarcode() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	n := int64(0)
	for _, v := range b {
		n = (n<<8 | int64(v)) % 100000000000
	}
	return fmt.Sprintf("42%011d", n)
}

func (s *seeder) nfc() string {
	b := make([]byte, 7)
	_, _ = rand.Read(b)
	parts := make([]string, 7)
	for i, v := range b {
		parts[i] = fmt.Sprintf("%02X", v)
	}
	return strings.Join(parts, ":")
}

// trayUUID is a Bambu tray_uuid: 32 upper-case hexadecimal characters.
func (s *seeder) trayUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return strings.ToUpper(hex.EncodeToString(b))
}

func (s *seeder) newSingleUse(at time.Time, key, label string) uuid.UUID {
	p := s.prods[key]
	m := s.mat(p.mat)
	svc := s.mlAt(at)
	sp, err := svc.CreateFilamentSpool(
		s.ctx,
		s.actor,
		machinelogbook.FilamentSpoolInput{
			MaterialID:               s.mats[p.mat].id,
			InitialNetWeightG:        f1(p.weight),
			StockMode:                "new_acquisition",
			TotalPrice:               ptr(f2(p.price * (0.97 + s.rng.Float64()*0.06))),
			TareWeightG:              ptr("210"),
			AcquiredOn:               &at,
			AcquisitionReference:     ptr(fmt.Sprintf("RE-%d-%04d", at.Year(), 1000+s.rng.Intn(8000))),
			StorageLocation:          ptr("Filament shelf"),
			Notes:                    ptr(label),
			OccurredAt:               at,
			ExpectedInventoryVersion: m.InventoryVersion,
		},
		nil,
	)
	check("spool "+key, err)
	_, err = svc.AddFilamentSpoolIdentifier(s.ctx, s.actor, sp.ID, "barcode", s.nextBarcode(), nil)
	check("identifier", err)
	return sp.ID
}

// registerSpool registers a 1 kg spool of the material (bought, or moved from loose stock) with the Bambu tray UUID
// its two RFID tags carry. It returns the spool and that tray UUID.
func (s *seeder) registerSpool(at time.Time, matName, mode string, price *string, label string) (uuid.UUID, string) {
	m := s.mat(matName)
	svc := s.mlAt(at)
	in := machinelogbook.FilamentSpoolInput{
		MaterialID:               s.mats[matName].id,
		InitialNetWeightG:        "1000",
		StockMode:                machinelogbook.StockMode(mode),
		TareWeightG:              ptr("250"),
		AcquiredOn:               &at,
		StorageLocation:          ptr("AMS"),
		Notes:                    ptr(label),
		OccurredAt:               at,
		ExpectedInventoryVersion: m.InventoryVersion,
	}
	if mode == "new_acquisition" {
		in.TotalPrice = price
		in.Supplier = ptr("Bambu Lab Store EU")
	}
	sp, err := svc.CreateFilamentSpool(s.ctx, s.actor, in, nil)
	check("spool "+label, err)
	trayUUID := s.trayUUID()
	_, err = svc.AddFilamentSpoolIdentifier(s.ctx, s.actor, sp.ID, machinelogbook.IdentifierBambuTrayUUID, trayUUID, nil)
	check("identifier", err)
	return sp.ID, trayUUID
}

func (s *seeder) newReusable(at time.Time, key, label, mode string) *reusable {
	p := s.prods[key]
	id, tag := s.registerSpool(at, p.mat, mode, ptr(f2(p.price)), label)
	r := &reusable{id: id, tag: tag, label: label}
	s.reus = append(s.reus, r)
	return r
}

func (s *seeder) mount(sl *slot, spool uuid.UUID, at time.Time) {
	_, err := s.printing.Mount(s.ctx, s.actor, sl.id, spool, nil)
	check("mount", err)
	// printing.Mount stamps the wall clock; backdate so history lookups resolve.
	_, err = s.pool.Exec(
		s.ctx,
		"UPDATE printer_spool_assignments SET mounted_at=$1 WHERE slot_id=$2 AND spool_id=$3 AND unmounted_at IS NULL",
		at.UTC(),
		sl.id,
		spool,
	)
	check("backdate mount", err)
	sl.cur = spool
}

func (s *seeder) spool(id uuid.UUID) machinelogbook.FilamentSpool {
	sp, err := s.ml.GetFilamentSpool(s.ctx, s.actor, id)
	check("get spool", err)
	return sp
}

// retireOutcome picks how a spool leaves: almost empty spools ran empty, others had their rest thrown away.
func (s *seeder) retireOutcome(sp machinelogbook.FilamentSpool, exhausted bool) machinelogbook.SpoolRetireOutcome {
	rem := dnum(sp.RemainingQuantity)
	if rem < 15 || (exhausted && s.rng.Float64() < 0.5) {
		return machinelogbook.SpoolRetiredEmpty
	}
	return machinelogbook.SpoolRetiredDiscarded
}

func (s *seeder) retire(id uuid.UUID, at time.Time, exhausted bool) {
	sp := s.spool(id)
	_, err := s.mlAt(at).RetireFilamentSpool(s.ctx, s.actor, id, sp.Version, s.retireOutcome(sp, exhausted), nil)
	check("retire spool "+sp.DisplayID, err)
}

// changeFill replaces the spool r holds: the old spool is retired and a new spool of the material takes its
// place (and its slot, when it has one).
func (s *seeder) changeFill(r *reusable, at time.Time, matName, source string, exhausted ...bool) {
	sp := s.spool(r.id)
	if !at.After(sp.CreatedAt.Add(time.Minute)) {
		at = sp.CreatedAt.Add(2 * time.Minute)
	}
	s.retire(r.id, at, len(exhausted) > 0 && exhausted[0])
	mode := "new_acquisition"
	if source == "loose" {
		m := s.mat(matName)
		if dnum(m.Quantity)-dnum(m.AssignedQuantity) >= 1000 {
			mode = "existing_stock"
		}
	}
	price := ptr("19.99")
	for _, p := range s.prods {
		if p.mat == matName && p.maker == "Bambu Lab" {
			price = ptr(f2(p.price * (0.96 + s.rng.Float64()*0.08)))
			break
		}
	}
	next := at.Add(time.Minute)
	r.id, r.tag = s.registerSpool(next, matName, mode, price, r.label)
	if r.slot != nil {
		s.mount(r.slot, r.id, next)
	}
}
