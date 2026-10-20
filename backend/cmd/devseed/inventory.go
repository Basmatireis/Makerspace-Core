package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
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
	_, err := s.ml.AddPurchase(s.ctx, s.actor, m.ID, m.InventoryVersion, q, f2(price), at, ptr(supplier), nil, nil)
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

func (s *seeder) newSingleUse(at time.Time, key, label string) uuid.UUID {
	p := s.prods[key]
	m := s.mat(p.mat)
	svc := s.mlAt(at)
	sp, err := svc.CreateFilamentSpool(
		s.ctx,
		s.actor,
		machinelogbook.FilamentSpoolInput{
			Kind:       "single_use",
			Label:      label,
			ProductID:  &p.id,
			MaterialID: s.mats[p.mat].id,
			InitialNetWeightG: f1(
				p.weight,
			),
			StockMode:                "new_acquisition",
			TotalPrice:               ptr(f2(p.price * (0.97 + s.rng.Float64()*0.06))),
			TareWeightG:              ptr("210"),
			AcquiredOn:               &at,
			AcquisitionReference:     ptr(fmt.Sprintf("RE-%d-%04d", at.Year(), 1000+s.rng.Intn(8000))),
			StorageLocation:          ptr("Filament shelf"),
			OccurredAt:               at,
			ExpectedInventoryVersion: m.InventoryVersion,
		},
		nil,
	)
	check("single-use spool "+key, err)
	_, err = svc.AddFilamentSpoolIdentifier(s.ctx, s.actor, sp.ID, "barcode", s.nextBarcode(), nil)
	check("identifier", err)
	return sp.ID
}

func (s *seeder) newReusable(at time.Time, key, label, mode string) *reusable {
	p := s.prods[key]
	m := s.mat(p.mat)
	svc := s.mlAt(at)
	in := machinelogbook.FilamentSpoolInput{
		Kind:                     "reusable",
		Label:                    label,
		ProductID:                &p.id,
		MaterialID:               s.mats[p.mat].id,
		InitialNetWeightG:        f1(p.weight),
		StockMode:                mode,
		TareWeightG:              ptr("250"),
		AcquiredOn:               &at,
		StorageLocation:          ptr("AMS"),
		OccurredAt:               at,
		ExpectedInventoryVersion: m.InventoryVersion,
	}
	if mode == "new_acquisition" {
		in.TotalPrice = ptr(f2(p.price))
	}
	sp, err := svc.CreateFilamentSpool(s.ctx, s.actor, in, nil)
	check("reusable spool "+label, err)
	_, err = svc.AddFilamentSpoolIdentifier(s.ctx, s.actor, sp.ID, "nfc", s.nfc(), nil)
	check("identifier", err)
	r := &reusable{id: sp.ID, label: label}
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

func (s *seeder) leftover(sp machinelogbook.FilamentSpool, exhausted bool) *machinelogbook.LeftoverInput {
	rem := dnum(sp.RemainingQuantity)
	tare := 250.0
	if sp.TareWeightG != nil {
		tare = dnum(*sp.TareWeightG)
	}
	if rem < 15 {
		return &machinelogbook.LeftoverInput{Basis: "none"}
	}
	if exhausted && rem < 200 {
		if s.rng.Float64() < 0.5 {
			return &machinelogbook.LeftoverInput{Basis: "none"}
		}
		return &machinelogbook.LeftoverInput{
			Basis:        "weighed",
			GrossWeightG: ptr(f1(tare + math.Floor(rem))),
			Disposition:  ptr("disposed"),
		}
	}
	switch r := s.rng.Float64(); {
	case r < 0.4:
		return &machinelogbook.LeftoverInput{Basis: "system", Disposition: ptr("returned_to_stock")}
	case r < 0.75:
		return &machinelogbook.LeftoverInput{
			Basis:        "weighed",
			GrossWeightG: ptr(f1(tare + math.Floor(rem*0.96))),
			Disposition:  ptr("returned_to_stock"),
		}
	default:
		if rem < 120 {
			return &machinelogbook.LeftoverInput{
				Basis:        "weighed",
				GrossWeightG: ptr(f1(tare + math.Floor(rem))),
				Disposition:  ptr("disposed"),
			}
		}
		return &machinelogbook.LeftoverInput{Basis: "system", Disposition: ptr("returned_to_stock")}
	}
}

func (s *seeder) changeFill(r *reusable, at time.Time, matName, source string, exhausted ...bool) {
	sp := s.spool(r.id)
	if sp.FilledAt != nil && !at.After(sp.FilledAt.Add(time.Minute)) {
		at = sp.FilledAt.Add(2 * time.Minute)
	}
	svc := s.mlAt(at)
	var lo *machinelogbook.LeftoverInput
	if sp.FillID != nil {
		lo = s.leftover(sp, len(exhausted) > 0 && exhausted[0])
	}
	var keep []uuid.UUID
	for _, id := range sp.Identifiers {
		keep = append(keep, id.ID)
	}
	fill := machinelogbook.NewFillInput{MaterialID: s.mats[matName].id, NetWeightG: "1000", Source: "purchase"}
	var key string
	for k, p := range s.prods {
		if p.mat == matName && p.maker == "Bambu Lab" && p.name != "PLA Matte Charcoal (refill)" {
			key = k
		}
	}
	if source == "loose" {
		m := s.mat(matName)
		// leftover returned in this very operation may not count yet; require existing loose stock
		if dnum(m.Quantity)-dnum(m.AssignedQuantity) >= 1000 {
			fill.Source = "loose_stock"
		}
	}
	if fill.Source == "purchase" {
		if key != "" {
			p := s.prods[key]
			fill.ProductID = &p.id
			fill.TotalPrice = ptr(f2(p.price * (0.96 + s.rng.Float64()*0.08)))
		} else {
			fill.TotalPrice = ptr("19.99")
		}
		fill.Supplier = ptr("Bambu Lab Store EU")
	}
	_, err := svc.ChangeFilamentSpoolFill(
		s.ctx,
		s.actor,
		r.id,
		machinelogbook.ChangeFillInput{
			Leftover:          lo,
			Fill:              fill,
			KeepIdentifierIDs: keep,
			OccurredAt:        at,
			ExpectedVersion:   sp.Version,
		},
		nil,
	)
	check(fmt.Sprintf("change fill %s %s", r.label, matName), err)
}
