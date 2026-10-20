package main

import (
	"fmt"
	"log"
	"math"
	"sort"
	"time"
	_ "time/tzdata"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/google/uuid"
)

var fdmTitles = []string{
	"Gearbox housing v3",
	"Sensor mount bracket",
	"Drone frame arm",
	"Enclosure for Raspberry Pi",
	"Cable clips (x20)",
	"Bachelor thesis prototype",
	"Prototype handle",
	"Test coupon PETG",
	"Replacement knob",
	"Lens holder",
	"Planetary gear test",
	"Wind turbine blade",
	"Pump impeller v2",
	"Phone stand",
	"Name badges",
	"Spacer rings",
	"Robotics chassis plate",
	"Hinge set",
}

var laserTitles = []string{
	"Acrylic nameplate",
	"Puzzle (plywood)",
	"Workshop signage",
	"Gasket 3 mm",
	"Enclosure panels",
	"Stencil set",
	"Lampshade",
	"Model bridge 1:50",
	"Engraved coasters",
	"Fachschaft Schild",
}

var notesList = []string{
	"Customer will pick up tomorrow",
	"Second attempt after warping on first try",
	"Supports removed by customer",
	"Rush job before deadline",
	"Material supplied partly by customer",
	"Used 0.2 mm layer height",
	"Test fit pending",
}

func (s *seeder) pickWeighted(w []float64) int {
	t := 0.0
	for _, v := range w {
		t += v
	}
	r := s.rng.Float64() * t
	for i, v := range w {
		r -= v
		if r <= 0 {
			return i
		}
	}
	return len(w) - 1
}

func (s *seeder) randStart() time.Time {
	today := s.now.In(s.loc)
	for {
		d := 1 + s.rng.Intn(182)
		day := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, s.loc).AddDate(0, 0, -d)
		w := []float64{0.05, 0.5, 1, 1, 1, 0.5, 0.1}[day.Weekday()]
		if (day.Month() == 7 && day.Day() > 17) || day.Month() == 8 || (day.Month() == 9) {
			w *= 0.35
		}
		if s.rng.Float64() > w {
			continue
		}
		var h float64
		switch {
		case s.rng.Float64() < 0.7 && (day.Weekday() == time.Tuesday || day.Weekday() == time.Thursday):
			h = 14 + s.rng.Float64()*4
		case s.rng.Float64() < 0.7 && day.Weekday() == time.Wednesday:
			h = 8 + s.rng.Float64()*4
		default:
			h = 9 + s.rng.Float64()*10
		}
		return day.Add(time.Duration(h * float64(time.Hour))).Truncate(time.Minute).UTC()
	}
}

func (s *seeder) pickCustomer() party {
	var w []float64
	for i, c := range s.custs {
		x := 1.0
		switch c.cat {
		case "student":
			x = 2.2 / math.Pow(float64(i%20+1), 0.45)
		case "staff":
			x = 0.8
		case "external":
			x = 0.5
		case "org":
			x = 3
		}
		w = append(w, x)
	}
	return s.custs[s.pickWeighted(w)]
}

func (s *seeder) planEverything() {
	// reserve prints and special runs first
	x1c, p1s := s.machines["x1c"], s.machines["p1s"]
	reserve := func(m *mach, a, b time.Time) { m.busy = append(m.busy, [2]time.Time{a, b}) }
	reserve(p1s, s.ago(75*time.Hour), s.ago(72*time.Hour))
	reserve(p1s, s.ago(29*time.Hour), s.ago(26*time.Hour))
	reserve(x1c, s.ago(49*time.Hour), s.ago(48*time.Hour+20*time.Minute))
	reserve(x1c, s.ago(55*time.Minute), s.now.Add(3*time.Hour))
	reserve(s.machines["pr1"], s.ago(25*time.Minute), s.now.Add(70*time.Minute))
	reserve(s.machines["pr2"], s.ago(5*time.Hour), s.ago(95*time.Minute))
	reserve(s.machines["laser"], s.ago(20*time.Hour), s.ago(19*time.Hour+10*time.Minute))
	reserve(s.machines["laser"], s.ago(30*time.Minute), s.now.Add(25*time.Minute))
	reserve(s.machines["pr1"], s.ago(26*time.Hour), s.ago(23*time.Hour))
	reserve(p1s, s.ago(7*time.Hour), s.ago(4*time.Hour)) // needs outcome on P1S? (kept free; see below)

	counts := map[string]int{"x1c": 40, "p1s": 28, "pr1": 28, "pr2": 22, "laser": 32}
	var plans []*plan
	for _, key := range []string{"x1c", "p1s", "pr1", "pr2", "laser"} {
		m := s.machines[key]
		for i := 0; i < counts[key]; i++ {
			var dur time.Duration
			if m.fdm {
				switch r := s.rng.Float64(); {
				case r < 0.45:
					dur = time.Duration((0.5 + s.rng.Float64()*2) * float64(time.Hour))
				case r < 0.8:
					dur = time.Duration((2.5 + s.rng.Float64()*3.5) * float64(time.Hour))
				default:
					dur = time.Duration((6 + s.rng.Float64()*8) * float64(time.Hour))
				}
			} else if s.rng.Float64() < 0.6 {
				dur = time.Duration((5 + s.rng.Float64()*15) * float64(time.Minute))
			} else {
				dur = time.Duration((20 + s.rng.Float64()*40) * float64(time.Minute))
			}
			p := &plan{m: m, customer: s.pickCustomer(), operator: s.supervisors[s.pickWeighted(s.opWeights)]}
			switch r := s.rng.Float64(); {
			case r < 0.82:
				p.outcome = "successful"
			case r < 0.89:
				p.outcome = "partial_failure"
			case r < 0.95:
				p.outcome = "failed"
				dur = time.Duration(float64(dur) * (0.15 + s.rng.Float64()*0.5))
			default:
				p.outcome = "cancelled"
				dur = time.Duration(float64(dur) * (0.1 + s.rng.Float64()*0.5))
			}
			if dur < 4*time.Minute {
				dur = 4 * time.Minute
			}
			ok := false
			for try := 0; try < 200; try++ {
				st := s.randStart()
				en := st.Add(dur)
				if en.After(s.ago(3*time.Hour)) || !m.free(st, en) {
					continue
				}
				p.start, p.end = st, en
				m.busy = append(m.busy, [2]time.Time{st, en})
				ok = true
				break
			}
			if !ok {
				continue
			}
			if s.rng.Float64() < 0.42 {
				if m.fdm {
					p.title = ptr(fdmTitles[s.rng.Intn(len(fdmTitles))])
				} else {
					p.title = ptr(laserTitles[s.rng.Intn(len(laserTitles))])
				}
			}
			if s.rng.Float64() < 0.12 {
				p.notes = ptr(notesList[s.rng.Intn(len(notesList))])
			}
			if p.customer.id == s.orgs["fs"].id && p.title == nil && !m.fdm {
				p.title = ptr("Fachschaft Schild")
			}
			if i == 0 && key == "pr1" {
				p.title = ptr("Fachschaft Schild")
				p.customer = s.orgs["fs"]
			}
			plans = append(plans, p)
		}
	}
	// two intentionally incomplete jobs: external customers using acrylic
	n := 0
	for _, p := range plans {
		if n < 2 && p.m == s.machines["laser"] && p.outcome == "successful" {
			p.acrylic = true
			p.customer = []party{s.orgs["startup"], s.custs[26]}[n]
			n++
		}
	}
	// linked-print jobs: most recent successful X1C/P1S jobs in the last 21 days
	sort.Slice(plans, func(i, j int) bool { return plans[i].start.After(plans[j].start) })
	cnt := map[string]int{}
	for _, p := range plans {
		if (p.m == x1c || p.m == p1s) && p.start.After(s.ago(21*24*time.Hour)) && p.outcome == "successful" {
			if cnt["create"] < 4 {
				p.mode = "create"
				cnt["create"]++
			} else if cnt["link"] < 4 {
				p.mode = "link"
				cnt["link"]++
			}
		}
	}
	sort.Slice(plans, func(i, j int) bool { return plans[i].start.Before(plans[j].start) })
	for _, p := range plans {
		p := p
		s.events = append(s.events, event{p.start, func() { s.runPlan(p) }})
	}
	log.Printf("planned %d jobs (%d create-from-print, %d link)", len(plans), cnt["create"], cnt["link"])

	// special runs
	op := func() uuid.UUID { return s.supervisors[s.pickWeighted(s.opWeights)] }
	special := []*plan{
		{
			m:        s.machines["pr1"],
			start:    s.ago(25 * time.Minute),
			end:      s.now.Add(70 * time.Minute),
			outcome:  "unknown",
			customer: s.custs[3],
			operator: op(),
			title:    ptr("Bracket for sensor mount"),
			special:  "running",
		},
		{
			m:        s.machines["laser"],
			start:    s.ago(30 * time.Minute),
			end:      s.now.Add(25 * time.Minute),
			outcome:  "unknown",
			customer: s.orgs["fs"],
			operator: op(),
			title:    ptr("Fachschaft Schild"),
			special:  "running",
		},
		{
			m:        s.machines["pr2"],
			start:    s.ago(5 * time.Hour),
			end:      s.ago(95 * time.Minute),
			outcome:  "unknown",
			customer: s.custs[7],
			operator: op(),
			special:  "needs_outcome",
		},
		{
			m:        s.machines["laser"],
			start:    s.ago(20 * time.Hour),
			end:      s.ago(19*time.Hour + 10*time.Minute),
			outcome:  "unknown",
			customer: s.custs[11],
			operator: op(),
			special:  "needs_outcome",
		},
		{
			m:        s.machines["pr1"],
			start:    s.ago(26 * time.Hour),
			end:      s.ago(23 * time.Hour),
			outcome:  "unknown",
			customer: s.custs[1],
			operator: op(),
			special:  "needs_outcome",
		},
	}
	for _, p := range special {
		p := p
		s.events = append(s.events, event{p.start, func() { s.runPlan(p) }})
	}

	// stock and spool events
	s.stockEvents()
	// unlinked prints and current print
	s.events = append(s.events, event{s.now.Add(-time.Minute), func() { s.unlinkedPrints() }})
}

func (s *seeder) stockEvents() {
	add := func(at time.Time, fn func()) { s.events = append(s.events, event{at, fn}) }
	d := func(m time.Month, day int) time.Time { return s.dateOf(m, day) }
	// sheet purchases
	for _, p := range []struct {
		name  string
		qty   float64
		price float64
		at    time.Time
	}{{"Plywood 3 mm", 2.16, 38.90, d(4, 6)}, {"Plywood 3 mm", 2.16, 41.00, d(8, 15)}, {"Plywood 4 mm", 1.80, 36.00, d(5, 12)}, {"Acrylic 3 mm clear", 1.20, 71.40, d(4, 7)}, {"Acrylic 3 mm clear", 1.20, 74.00, d(8, 28)}, {"MDF 3 mm", 1.80, 16.50, d(6, 3)}} {
		p := p
		add(p.at, func() { s.purchase(p.name, p.qty, p.price, p.at, "Modulor Material Shop", 3) })
	}
	// bulk filament (loose stock)
	for _, p := range []struct {
		name  string
		qty   float64
		price float64
		at    time.Time
	}{{"PLA White", 2000, 34, d(4, 6)}, {"PLA Black", 2000, 34, d(4, 6)}, {"PETG Black", 1000, 18.5, d(5, 20)}, {"PLA Grey", 1000, 17, d(6, 1)}, {"PLA Red", 1000, 16.5, d(6, 10)}} {
		p := p
		add(p.at, func() { s.purchase(p.name, p.qty, p.price, p.at, "Filamentworld Großhandel", 0) })
	}
	t0 := d(4, 8)
	// initial setup
	add(t0, func() {
		x1c, p1s := s.machines["x1c"], s.machines["p1s"]
		def := []struct {
			m   *mach
			i   int
			key string
		}{{x1c, 0, "bl-black"}, {x1c, 1, "bl-white"}, {x1c, 2, "bl-grey"}, {x1c, 3, "bl-petg"}, {p1s, 0, "bl-white"}, {p1s, 1, "bl-black"}}
		for _, df := range def {
			label := fmt.Sprintf("AMS 1 · Slot %d", df.i+1)
			if df.m == p1s {
				label = fmt.Sprintf("P1S AMS · Slot %d", df.i+1)
			}
			r := s.newReusable(t0.Add(time.Duration(len(s.reus))*time.Minute), df.key, label, "new_acquisition")
			r.slot = df.m.slots[df.i]
			df.m.slots[df.i].reu = r
			s.mount(df.m.slots[df.i], r.id, t0)
		}
		for _, k := range []string{"x1c", "p1s", "pr1", "pr2"} {
			_ = k
		}
		// shelf spare that later needs refill
		r8 := s.newReusable(t0.Add(30*time.Minute), "bl-red", "Shelf A · Spare 2", "new_acquisition")
		_ = r8
		// Prusa spools and X1C external spool
		for _, k := range []string{"pr1", "pr2", "x1c"} {
			m := s.machines[k]
			sl := m.slots[len(m.slots)-1]
			if k == "x1c" {
				sl = m.slots[4]
			}
			sl.gi = 0
			spool := s.newSingleUse(t0.Add(10*time.Minute), sl.gens[0].prod, fmt.Sprintf("%s · Spool", m.name))
			s.mount(sl, spool, t0)
		}
	})
	// r8 planned change and finish
	add(d(6, 1), func() { s.changeFill(s.reus[6], d(6, 1), "PLA Red", "purchase") })
	add(d(9, 28), func() {
		r := s.reus[6]
		sp := s.spool(r.id)
		at := d(9, 28)
		_, err := s.mlAt(at).
			FinishFilamentSpool(
				s.ctx,
				s.actor,
				r.id,
				machinelogbook.FinishSpoolInput{
					Leftover:        *s.leftover(sp, false),
					OccurredAt:      at,
					ExpectedVersion: sp.Version,
				},
				nil,
			)
		check("finish r8", err)
	})
	add(d(7, 15), func() {
		r := s.newReusable(d(7, 15), "bl-red", "Shelf A · Spare 1", "existing_stock")
		_ = r
	})
	add(d(9, 20), func() { s.changeFill(s.reus[7], d(9, 20), "PLA Red", "purchase") })
	changes := []struct {
		reu  int
		at   time.Time
		mat  string
		mode string
	}{{0, d(8, 1), "PLA Black", "purchase"}, {5, d(7, 8), "PLA White", "loose"}, {1, d(6, 18), "PLA Red", "purchase"}, {2, d(9, 5), "PLA White", "loose"}, {3, d(7, 22), "PLA Black", "loose"}, {4, d(8, 12), "PLA Grey", "purchase"}}
	for _, c := range changes {
		c := c
		add(c.at, func() { s.changeFill(s.reus[c.reu], c.at, c.mat, c.mode) })
	}
	// unopened single-use stock
	for _, u := range []struct {
		key string
		at  time.Time
	}{{"pr-pla", d(4, 9)}, {"pr-petg-clear", d(6, 20)}, {"pr-petg-black", d(8, 5)}, {"ex-grey", d(9, 25)}} {
		u := u
		add(u.at, func() { s.newSingleUse(u.at, u.key, "Shelf B · Unopened") })
	}
}

// ---------- execution ----------

func (s *seeder) runTimeline() {
	sort.SliceStable(s.events, func(i, j int) bool { return s.events[i].at.Before(s.events[j].at) })
	for i, e := range s.events {
		if i%25 == 0 {
			log.Printf("timeline %d/%d (%s)", i, len(s.events), e.at.In(s.loc).Format("2006-01-02"))
		}
		e.fn()
	}
}

// ensure makes sure the slot's spool can supply qty, rotating or refilling when needed.
// It returns the spool and the (possibly capped) quantity; spool==Nil means no usable spool.
func (s *seeder) ensure(sl *slot, qty float64, at time.Time) (uuid.UUID, float64) {
	if sl.cur == uuid.Nil {
		return uuid.Nil, 0
	}
	sp := s.spool(sl.cur)
	rem := dnum(sp.RemainingQuantity)
	if sl.reu != nil {
		if rem < qty+1 {
			s.changeFill(sl.reu, at.Add(-8*time.Minute), *sp.MaterialName, "purchase", true)
			sp = s.spool(sl.cur)
		}
		return sl.cur, qty
	}
	due := sl.gi+1 < len(sl.gens) && !sl.gens[sl.gi].rotate.IsZero() && at.After(sl.gens[sl.gi].rotate)
	if (rem < qty+1 || due) && sl.gi+1 < len(sl.gens) {
		fa := at.Add(-9 * time.Minute)
		if sp.FilledAt != nil && !fa.After(sp.FilledAt.Add(time.Minute)) {
			fa = sp.FilledAt.Add(2 * time.Minute)
		}
		_, err := s.mlAt(fa).
			FinishFilamentSpool(
				s.ctx,
				s.actor,
				sl.cur,
				machinelogbook.FinishSpoolInput{
					Leftover:        *s.leftover(sp, rem < qty+1),
					OccurredAt:      fa,
					ExpectedVersion: sp.Version,
				},
				nil,
			)
		check("finish spool", err)
		sl.gi++
		sl.cur = uuid.Nil
		na := fa.Add(2 * time.Minute)
		id := s.newSingleUse(na, sl.gens[sl.gi].prod, fmt.Sprintf("%s · Spool", slotMachine(s, sl)))
		s.mount(sl, id, na)
		return sl.cur, qty
	}
	if rem < qty+1 {
		qty = math.Floor(rem - 1)
		if qty < 5 {
			return uuid.Nil, 0
		}
	}
	return sl.cur, qty
}

func slotMachine(s *seeder, sl *slot) string {
	for _, m := range s.machines {
		for _, x := range m.slots {
			if x == sl {
				return m.name
			}
		}
	}
	return "Printer"
}

func (s *seeder) usagesFor(p *plan, single bool) ([]machinelogbook.UsageInput, *slot, float64) {
	m := p.m
	hours := p.end.Sub(p.start).Hours()
	if m.fdm {
		total := math.Max(3, hours*(12+s.rng.Float64()*23))
		var cand []*slot
		var w []float64
		for i, sl := range m.slots {
			if sl.cur == uuid.Nil && sl.gi == 0 && len(sl.gens) == 0 {
				continue
			}
			wt := 1.0
			if m.bambu {
				wt = []float64{3, 2, 2, 2, 1.2}[i]
			}
			if m == s.machines["p1s"] && i >= 2 {
				continue
			}
			cand = append(cand, sl)
			w = append(w, wt)
		}
		n := 1
		if !single && m.bambu && s.rng.Float64() < 0.25 && len(cand) > 1 {
			n = 2
		}
		var out []machinelogbook.UsageInput
		var primary *slot
		used := map[int]bool{}
		for k := 0; k < n; k++ {
			i := s.pickWeighted(w)
			for used[i] {
				i = (i + 1) % len(cand)
			}
			used[i] = true
			q := total
			if n == 2 {
				q = total * []float64{0.65, 0.35}[k]
			}
			sl := cand[i]
			if p.outcome == "partial_failure" {
				q *= 1.1
			}
			spoolID, qq := s.ensure(sl, q, p.start)
			if spoolID == uuid.Nil {
				out = append(
					out,
					machinelogbook.UsageInput{
						Ownership:            "external",
						ExternalMaterialName: ptr("Customer-supplied PLA"),
						Quantity:             f1(q),
					},
				)
				continue
			}
			if primary == nil {
				primary = sl
			}
			sp := s.spool(spoolID)
			out = append(
				out,
				machinelogbook.UsageInput{
					MaterialID:    *sp.MaterialID,
					SpoolID:       &spoolID,
					Ownership:     "makerspace",
					Quantity:      f1(qq),
					QuantityBasis: "actual",
				},
			)
		}
		var q0 float64
		if len(out) > 0 {
			q0 = dnum(out[0].Quantity)
		}
		return out, primary, q0
	}
	// laser
	name := []string{
		"Plywood 3 mm",
		"Plywood 4 mm",
		"Acrylic 3 mm clear",
		"MDF 3 mm",
	}[s.pickWeighted([]float64{4, 1.5, 2.5, 2})]
	if p.acrylic {
		name = "Acrylic 3 mm clear"
	}
	area := math.Round((0.02+s.rng.Float64()*0.3)*1000) / 1000
	if p.outcome == "failed" || p.outcome == "cancelled" {
		area /= 2
	}
	mm := s.mat(name)
	if dnum(mm.Quantity) < area+0.05 {
		s.purchase(name, 1.8, 35, p.start.Add(-24*time.Hour), "Modulor Material Shop", 3)
	}
	return []machinelogbook.UsageInput{
		{MaterialID: s.mats[name].id, Ownership: "makerspace", Quantity: f3(area), QuantityBasis: "actual"},
	}, nil, 0
}

func (s *seeder) runPlan(p *plan) {
	var usages []machinelogbook.UsageInput
	var prim *slot
	var q0 float64
	if p.special == "" {
		usages, prim, q0 = s.usagesFor(p, p.mode != "")
	} else if p.m.fdm {
		// running/needs-outcome FDM runs: consumption from the mounted spool
		usages, prim, q0 = s.usagesFor(p, true)
	}
	_ = q0
	in := machinelogbook.JobInput{
		MachineID:        p.m.id,
		Title:            p.title,
		StartsAt:         p.start,
		EndsAt:           p.end,
		Customer:         p.customer.ref(),
		OperatorPersonID: p.operator,
		Outcome:          machinelogbook.JobOutcome(p.outcome),
		Notes:            p.notes,
		Usages:           usages,
	}
	var job machinelogbook.MachineJob
	var err error
	switch p.mode {
	case "create":
		file := fdmFiles[s.rng.Intn(len(fdmFiles))]
		var rep *float64
		slotExt := ""
		if prim != nil {
			q := dnum(usages[0].Quantity)
			rep = &q
			slotExt = prim.ext
		}
		run := s.printRun(p.m, p.start, p.end, "completed", file, rep, slotExt)
		job, err = s.ml.CreateJobFromRun(
			s.ctx,
			s.actor,
			run,
			machinelogbook.RunJobInput{
				Title:            p.title,
				Customer:         p.customer.ref(),
				OperatorPersonID: p.operator,
				Notes:            p.notes,
			},
			nil,
		)
		check("create from print", err)
	case "link":
		in.Usages = usages[:min(1, len(usages))]
		in.StartsAt = p.start.Add(2 * time.Minute)
		in.EndsAt = p.end.Add(-3 * time.Minute)
		job, err = s.ml.CreateManualJob(s.ctx, s.actor, in, nil)
		check("link: manual job", err)
		file := fdmFiles[s.rng.Intn(len(fdmFiles))]
		var rep *float64
		slotExt := ""
		if prim != nil {
			q := dnum(usages[0].Quantity)
			rep = &q
			slotExt = prim.ext
		}
		run := s.printRun(p.m, p.start, p.end, "completed", file, rep, slotExt)
		job, err = s.ml.AttachRun(s.ctx, s.actor, run, job.ID, true, job.Version, nil)
		check("link print", err)
	default:
		job, err = s.ml.CreateManualJob(s.ctx, s.actor, in, nil)
		check("manual job", err)
	}
	s.jobs = append(
		s.jobs,
		jobRec{
			id:         job.ID,
			customer:   p.customer,
			outcome:    p.outcome,
			incomplete: job.PricingStatus != "complete",
			ends:       p.end,
			machine:    p.m.name,
			failedRun:  p.outcome == "failed",
		},
	)
}
