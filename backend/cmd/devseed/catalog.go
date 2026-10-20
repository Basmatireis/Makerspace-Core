package main

import (
	"fmt"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/google/uuid"
)

func (s *seeder) createOrgsAndPricing() {
	ml := s.ml
	newOrgs := map[string]bool{}
	mk := func(name, kind, key string) {
		id, create := s.claim("organizations", name, "active")
		if create != "" {
			o, err := ml.CreateOrganization(
				s.ctx,
				s.actor,
				create,
				kind,
				machinelogbook.OrganizationDetailsInput{},
				nil,
			)
			check("org", err)
			id, name = o.ID, create
			newOrgs[key] = true
		}
		s.orgs[key] = party{"organization", id, "org", name}
	}
	mk("Lehrstuhl für Produktentwicklung", "institute", "chair")
	mk("Fachschaft Maschinenbau", "association", "fs")
	mk("Startup Kleinteil GmbH", "company", "startup")

	_, hasDefault := s.existing("SELECT id FROM pricing_groups WHERE is_default")
	group := func(name, desc string, isDefault bool) (uuid.UUID, bool) {
		id, create := s.claim("pricing_groups", name, "active")
		if create == "" {
			return id, false
		}
		g, err := ml.CreatePricingGroup(s.ctx, s.actor, create, ptr(desc), isDefault && !hasDefault, nil)
		check("pg", err)
		return g.ID, true
	}
	students, studentsNew := group("Students", "Default rates for enrolled students", true)
	staff, staffNew := group("University staff", "Employees of the university and its institutes", false)
	ext, extNew := group("External", "Companies and private persons", false)

	// Material types are what prices attach to; materials are variants of them.
	for _, t := range [][2]string{
		{"PLA", "g"},
		{"PETG", "g"},
		{"TPU 95A", "g"},
		{"ASA", "g"},
		{"Plywood", "m2"},
		{"Acrylic", "m2"},
		{"MDF", "m2"},
	} {
		if t[1] == "g" {
			s.materialType(t[0], t[1], "fdm_printing")
		} else {
			s.materialType(t[0], t[1], "laser_cutting", "other")
		}
	}
	// Types for the other processes (embroidery, UV printing, plotting, cm2 sheets).
	for _, t := range []struct {
		name, unit string
		processes  []string
	}{
		{"Stabilizer (tear-away)", "m", []string{"embroidery"}},
		{"UV ink", "ml", []string{"uv_printing"}},
		{"DTF sticker paper", "cm2", []string{"uv_printing"}},
		{"Roll-to-film", "m", []string{"uv_printing"}},
		{"Birch plywood", "cm2", []string{"laser_cutting", "other"}},
		{"Vinyl foil", "cm2", []string{"vinyl_cutting", "other"}},
	} {
		s.materialType(t.name, t.unit, t.processes...)
	}
	machineType := func(name, process string) uuid.UUID {
		id, create := s.claim("machine_types", name, "active")
		if create != "" {
			mt, err := ml.CreateMachineType(s.ctx, s.actor, create, process, nil)
			check("mt", err)
			id = mt.ID
		}
		return id
	}
	ftype := machineType("FDM 3D printer", "fdm_printing")
	ltype := machineType("Laser cutter", "laser_cutting")
	etype := machineType("Embroidery machine", "embroidery")
	utype := machineType("UV printer", "uv_printing")
	ptype := machineType("Vinyl plotter", "vinyl_cutting")

	// Rules are only added to groups this run created; reused groups keep
	// their pricing.
	type rates struct{ fdm, laser, fil, ply, acr, mdf float64 }
	for _, g := range []struct {
		id  uuid.UUID
		new bool
		r   rates
		x   bool
	}{{students, studentsNew, rates{0.5, 6, 0.03, 12, 35, 8}, false}, {staff, staffNew, rates{1, 12, 0.04, 18, 50, 12}, false}, {ext, extNew, rates{3, 30, 0.08, 40, 0, 28}, true}} {
		if !g.new {
			continue
		}
		rule := func(kind string, mt, material *uuid.UUID, rate float64) {
			_, err := ml.CreatePricingRule(s.ctx, s.actor, g.id, kind, mt, material, nil, f3(rate), nil)
			check("rule", err)
		}
		material := func(name string) *uuid.UUID { id := s.matTypes[name]; return &id }
		rule("machine_runtime", &ftype, nil, g.r.fdm)
		rule("machine_runtime", &ltype, nil, g.r.laser)
		// Filament is priced per type: PETG, ASA and TPU cost more than PLA.
		rule("material", nil, material("PLA"), g.r.fil)
		rule("material", nil, material("PETG"), g.r.fil*1.2)
		rule("material", nil, material("ASA"), g.r.fil*1.3)
		rule("material", nil, material("TPU 95A"), g.r.fil*2)
		rule("material", nil, material("Plywood"), g.r.ply)
		if !g.x { // External deliberately has no acrylic rule (incomplete pricing demo)
			rule("material", nil, material("Acrylic"), g.r.acr)
		}
		rule("material", nil, material("MDF"), g.r.mdf)
	}
	// Rules for the other processes. They are added to every group that does not
	// price the machine type or material type yet, so reused databases get them too.
	type processRates struct{ embroidery, stitches, uv, ink, dtf, film, stabilizer, plywood, vinyl, plotter float64 }
	for _, g := range []struct {
		id uuid.UUID
		r  processRates
	}{
		{students, processRates{2, 0.35, 4, 0.9, 0.004, 3, 0.8, 0.0012, 0.002, 0}},
		{staff, processRates{4, 0.5, 8, 1.2, 0.006, 4, 1, 0.0018, 0.003, 0}},
		{ext, processRates{9, 1, 20, 2, 0.012, 8, 2, 0.004, 0.006, 6}},
	} {
		rule := func(kind string, mt, material *uuid.UUID, measure *string, rate float64) {
			var selector uuid.UUID
			switch {
			case mt != nil:
				selector = *mt
			case material != nil:
				selector = *material
			}
			if _, taken := s.existing(
				"SELECT id FROM pricing_rules WHERE pricing_group_id = $1 AND kind = $2 AND active AND COALESCE(machine_type_id, material_type_id) = $3 AND measure IS NOT DISTINCT FROM $4::text",
				g.id,
				kind,
				selector,
				measure,
			); taken {
				return
			}
			_, err := ml.CreatePricingRule(s.ctx, s.actor, g.id, kind, mt, material, measure, f4(rate), nil)
			check("rule", err)
		}
		typeID := func(name string) *uuid.UUID { id := s.matTypes[name]; return &id }
		rule("machine_runtime", &etype, nil, nil, g.r.embroidery)
		rule("machine_measure", &etype, nil, ptr("stitches"), g.r.stitches) // per 1000 stitches
		rule("machine_runtime", &utype, nil, nil, g.r.uv)
		rule("machine_runtime", &ptype, nil, nil, g.r.plotter) // 0 EUR/h: plotter time is not charged to members
		rule("material", nil, typeID("UV ink"), nil, g.r.ink)
		rule("material", nil, typeID("DTF sticker paper"), nil, g.r.dtf)
		rule("material", nil, typeID("Roll-to-film"), nil, g.r.film)
		rule("material", nil, typeID("Stabilizer (tear-away)"), nil, g.r.stabilizer)
		rule("material", nil, typeID("Birch plywood"), nil, g.r.plywood)
		rule("material", nil, typeID("Vinyl foil"), nil, g.r.vinyl)
	}
	assign := func(p party, g uuid.UUID) {
		_, err := ml.SetPartyPricingGroup(s.ctx, s.actor, p.ref(), &g, 0, nil)
		check("assign pg", err)
	}
	for _, c := range s.custs {
		switch c.cat {
		case "staff":
			assign(c, staff)
		case "external":
			assign(c, ext)
		}
	}
	// Reused organizations keep their pricing group.
	for key, g := range map[string]uuid.UUID{"chair": staff, "fs": students, "startup": ext} {
		if newOrgs[key] {
			assign(s.orgs[key], g)
		}
	}
	s.machines["_ftype"] = &mach{id: ftype}
	s.machines["_ltype"] = &mach{id: ltype}
	s.machines["_etype"] = &mach{id: etype}
	s.machines["_utype"] = &mach{id: utype}
	s.machines["_ptype"] = &mach{id: ptype}
	s.custs = append(s.custs, s.orgs["chair"], s.orgs["fs"], s.orgs["startup"])
}

// materialType returns the material type with this name, creating it when it
// does not exist yet. An existing type keeps its unit and processes.
func (s *seeder) materialType(name, unit string, processes ...string) uuid.UUID {
	if id, ok := s.matTypes[name]; ok {
		return id
	}
	id, ok := s.existing("SELECT id FROM material_types WHERE lower(name) = lower($1) AND unit = $2", name, unit)
	if !ok {
		createName := name
		if _, taken := s.existing("SELECT id FROM material_types WHERE lower(name) = lower($1)", name); taken {
			createName = s.tagged(name) // same name, other unit: keep both
		}
		t, err := s.ml.CreateMaterialType(s.ctx, s.actor, createName, unit, processes, nil)
		check("material type", err)
		id = t.ID
	}
	s.matTypes[name] = id
	return id
}

func (s *seeder) createCatalog() {
	ml := s.ml
	// Materials are reused when name and unit match.
	material := func(name, typeName, unit string, colorName, colorHex *string) {
		typeID := s.materialType(typeName, unit)
		id, create := s.claim("materials", name, "active AND unit = $2", unit)
		if create != "" {
			in := machinelogbook.MaterialInput{
				Name:           create,
				MaterialTypeID: typeID,
				ColorName:      colorName,
				ColorHex:       colorHex,
			}
			if unit == "g" {
				in.FilamentDiameterMM = ptr("1.75")
			}
			m, err := ml.CreateMaterial(s.ctx, s.actor, in, nil)
			check("mat", err)
			id = m.ID
			s.newMats[name] = true
		}
		s.mats[name] = &mat{id, name, typeName}
	}
	for _, f := range []struct{ name, typeName, colorName, hex string }{
		{"PLA Black", "PLA", "Black", "#1A1A1A"}, {
			"PLA White",
			"PLA",
			"White",
			"#F2F2F2",
		}, {"PLA Grey", "PLA", "Grey", "#8C8C8C"}, {"PLA Red", "PLA", "Red", "#C62828"},
		{"PETG Black", "PETG", "Black", "#222222"}, {"PETG Clear", "PETG", "Clear", "#DDE8EE"}, {
			"TPU 95A Black",
			"TPU 95A",
			"Black",
			"#111111",
		}, {"ASA White", "ASA", "White", "#FAFAFA"},
	} {
		material(f.name, f.typeName, "g", ptr(f.colorName), ptr(f.hex))
	}
	for _, f := range [][2]string{
		{"Plywood 3 mm", "Plywood"},
		{"Plywood 4 mm", "Plywood"},
		{"Acrylic 3 mm clear", "Acrylic"},
		{"MDF 3 mm", "MDF"},
	} {
		material(f[0], f[1], "m2", nil, nil)
	}
	// Materials of the other processes. They stay out of newMats: the generic
	// stock thresholds are sized for grams and square metres.
	extra := func(name, typeName, unit string, colorName, colorHex *string) {
		typeID := s.materialType(typeName, unit)
		id, create := s.claim("materials", name, "active AND unit = $2", unit)
		if create != "" {
			m, err := ml.CreateMaterial(
				s.ctx,
				s.actor,
				machinelogbook.MaterialInput{
					Name:              create,
					MaterialTypeID:    typeID,
					ColorName:         colorName,
					ColorHex:          colorHex,
					LowStockThreshold: nil,
				},
				nil,
			)
			check("mat", err)
			id = m.ID
		}
		s.mats[name] = &mat{id, name, typeName}
	}
	for _, ink := range []struct{ name, color, hex string }{
		{"UV ink Cyan", "Cyan", "#00AEEF"}, {
			"UV ink Magenta",
			"Magenta",
			"#EC008C",
		}, {"UV ink Yellow", "Yellow", "#FFF200"},
		{"UV ink Black", "Black", "#1A1A1A"}, {"UV ink White", "White", "#F5F5F5"},
	} {
		extra(ink.name, "UV ink", "ml", ptr(ink.color), ptr(ink.hex))
	}
	extra("DTF sticker paper A4", "DTF sticker paper", "cm2", nil, nil)
	extra("Roll-to-film 30 cm", "Roll-to-film", "m", nil, nil)
	extra("Tear-away stabilizer", "Stabilizer (tear-away)", "m", nil, nil)
	extra("Birch plywood 4 mm sheet", "Birch plywood", "cm2", nil, nil)
	extra("Vinyl foil matt white", "Vinyl foil", "cm2", nil, nil)

	// Products are reused when they belong to the same material.
	prod := func(key, maker, name, matName, pack string, weight, price float64, active bool) {
		matID := s.mats[matName].id
		const byName = "SELECT id FROM filament_products WHERE lower(manufacturer) = lower($1) AND lower(name) = lower($2)"
		id, ok := s.existing(byName+" AND material_id = $3 AND (active OR NOT $4)", maker, name, matID, active)
		if !ok {
			createName := name
			if _, taken := s.existing(byName, maker, name); taken {
				createName = s.tagged(name)
			}
			in := machinelogbook.FilamentProductInput{
				Manufacturer: maker,
				Name:         createName,
				NetWeightG:   f1(weight),
				Packaging:    pack,
				MaterialID:   matID,
				DefaultPrice: ptr(f2(price)),
				Active:       true,
			}
			p, err := ml.CreateFilamentProduct(s.ctx, s.actor, in, nil)
			check("product", err)
			if !active {
				in.Active, in.ExpectedVersion = false, p.Version
				_, err = ml.UpdateFilamentProduct(s.ctx, s.actor, p.ID, in, nil)
				check("product deactivate", err)
			}
			id = p.ID
		}
		s.prods[key] = &product{id, matName, name, maker, weight, price}
	}
	prod("bl-black", "Bambu Lab", "PLA Basic Black (refill)", "PLA Black", "refill", 1000, 17.49, true)
	prod("bl-white", "Bambu Lab", "PLA Basic White (refill)", "PLA White", "refill", 1000, 17.49, true)
	prod("bl-grey", "Bambu Lab", "PLA Basic Grey (refill)", "PLA Grey", "refill", 1000, 17.49, true)
	prod("bl-red", "Bambu Lab", "PLA Basic Red (refill)", "PLA Red", "refill", 1000, 17.49, true)
	prod("bl-petg", "Bambu Lab", "PETG HF Black (refill)", "PETG Black", "refill", 1000, 19.99, true)
	prod("bl-charcoal", "Bambu Lab", "PLA Matte Charcoal (refill)", "PLA Black", "refill", 1000, 21.99, false)
	prod("pr-pla", "Prusa Research", "Prusament PLA Prusa Galaxy Black", "PLA Black", "spool", 1000, 29.99, true)
	prod("pr-petg-black", "Prusa Research", "Prusament PETG Jet Black", "PETG Black", "spool", 1000, 29.99, true)
	prod("pr-petg-clear", "Prusa Research", "Prusament PETG Clear", "PETG Clear", "spool", 1000, 29.99, true)
	prod("ex-grey", "Extrudr", "PLA NX2 Grey", "PLA Grey", "spool", 1000, 26.50, true)
	prod("ex-tpu", "Extrudr", "TPU Medium Black", "TPU 95A Black", "spool", 500, 27.90, true)
	prod("pm-asa", "Polymaker", "ASA White", "ASA White", "spool", 1000, 24.99, true)
}

// freeName returns name, or its tagged variant when table already uses it.
func (s *seeder) freeName(table, name string) string {
	if _, taken := s.existing("SELECT id FROM "+table+" WHERE lower(name) = lower($1)", name); taken {
		return s.tagged(name)
	}
	return name
}

func (s *seeder) setupPrinters() {
	ml := s.ml
	mk := func(key, name, typeKey string, fdm, bambu bool, ext *string) *mach {
		name = s.freeName("machines", name)
		if ext != nil {
			if _, taken := s.existing("SELECT id FROM machines WHERE external_identifier = $1", *ext); taken {
				ext = ptr((*ext)[:7] + strings.ToUpper(s.randHex(4))) // crypto/rand: same -seed reruns must not collide
			}
		}
		m, err := ml.CreateMachine(s.ctx, s.actor, s.machines[typeKey].id, name, "active", ext, ext != nil, nil)
		check("machine", err)
		mm := &mach{id: m.ID, name: name, fdm: fdm, bambu: bambu}
		s.machines[key] = mm
		return mm
	}
	x1c := mk("x1c", "Bambu Lab X1 Carbon", "_ftype", true, true, ptr("00M09A3B0100451"))
	p1s := mk("p1s", "Bambu Lab P1S", "_ftype", true, true, ptr("01P00A3C2200312"))
	pr1 := mk("pr1", "Prusa MK4 #1", "_ftype", true, false, nil)
	pr2 := mk("pr2", "Prusa MK4 #2", "_ftype", true, false, nil)
	mk("laser", "Trotec Speedy 300", "_ltype", false, false, nil)
	mk("embroidery", "Brother PR1055X", "_etype", false, false, nil)
	mk("uv", "eufy Make E1", "_utype", false, false, nil)
	mk("plotter", "Silhouette Cameo 5", "_ptype", false, false, nil)

	profile := func(m *mach) {
		_, err := s.printing.ConfigureProfile(s.ctx, s.actor, m.id, true, 0, nil)
		check("profile", err)
	}
	unit := func(m *mach, name string, pos int) uuid.UUID {
		u, err := s.printing.CreateInputUnit(s.ctx, s.actor, m.id, name, pos, nil, nil)
		check("unit", err)
		return u.ID
	}
	addSlot := func(m *mach, unitID uuid.UUID, name string, pos int, ext string) *slot {
		sl, err := s.printing.CreateSlot(s.ctx, s.actor, unitID, name, pos, "available", ptr(ext), nil)
		check("slot", err)
		sp := &slot{id: sl.ID, ext: ext, name: name}
		m.slots = append(m.slots, sp)
		return sp
	}
	for _, m := range []*mach{x1c, p1s} {
		profile(m)
		u := unit(m, "AMS 1", 0)
		for i := 0; i < 4; i++ {
			addSlot(m, u, fmt.Sprintf("Slot %d", i+1), i, fmt.Sprintf("ams0.slot%d", i))
		}
		e := unit(m, "External spool", 1)
		addSlot(m, e, "External spool", 0, "external")
	}
	for _, m := range []*mach{pr1, pr2} {
		profile(m)
		u := unit(m, "Spool holder", 0)
		addSlot(m, u, "Spool", 0, "holder")
	}
	// Prusa spool generations
	pr1.slots[0].gens = []gen{{"pr-pla", s.dateOf(6, 8)}, {"pr-petg-black", s.dateOf(9, 2)}, {"pr-pla", time.Time{}}}
	pr2.slots[0].gens = []gen{{"pr-petg-clear", s.dateOf(6, 22)}, {"ex-grey", s.dateOf(8, 26)}, {"pm-asa", time.Time{}}}
	x1c.slots[4].gens = []gen{{"ex-tpu", time.Time{}}}
}
