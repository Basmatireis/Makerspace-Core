package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"log"
	"time"
	_ "time/tzdata"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors"
	"github.com/google/uuid"
)

func (s *seeder) setupConnector() {
	c, err := s.pc.Create(
		s.ctx,
		s.actor,
		s.freeName("printer_connectors", "Workshop printer connector"),
		ptr("Print lab, bench 2"),
		nil,
	)
	check("connector", err)
	enr, err := s.pc.IssueEnrollment(s.ctx, s.actor, c.ID, nil)
	check("enrollment", err)
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	secret := base64.RawURLEncoding.EncodeToString(b)
	_, err = s.pc.Enroll(s.ctx, enr.Secret, ids.New(), secret, "devseed-1.0.0", 1)
	check("enroll", err)
	cx, err := s.pc.Authenticate(s.ctx, secret)
	check("auth", err)
	if cx == nil {
		log.Fatal("connector authentication failed")
	}
	s.connCtx = *cx
	for _, k := range []string{"x1c", "p1s"} {
		m := s.machines[k]
		a, err := s.pc.CreateAssignment(
			s.ctx,
			s.actor,
			c.ID,
			printerconnectors.AssignmentInput{
				MachineID:            m.id,
				AdapterKind:          "simulator",
				AdapterSchemaVersion: 1,
				Settings:             json.RawMessage(`{"scenario":"idle"}`),
			},
			nil,
		)
		check("assignment", err)
		m.assign = a.ID
		m.cfgVer = a.ConfigurationVersion
	}
	as, err := s.pc.ListAssignments(s.ctx, s.actor, c.ID)
	check("list assignments", err)
	for _, a := range as {
		for _, k := range []string{"x1c", "p1s"} {
			if s.machines[k].assign == a.ID {
				s.machines[k].cfgVer = a.ConfigurationVersion
			}
		}
	}
}

func (s *seeder) ingest(m *mach, run uuid.UUID, ext string, kind printing.EventKind, at time.Time, payload map[string]any, rev *int64) {
	m.seq++
	raw, _ := json.Marshal(payload)
	rc, err := s.pc.IngestEvents(
		s.ctx,
		s.connCtx,
		[]printerconnectors.EventInput{
			{EventID: ids.New(), AssignmentID: m.assign, RunID: &run, HistoryComplete: true,
				ConfigurationVersion: m.cfgVer,
				Sequence:             m.seq,
				OccurredAt:           at.UTC(),
				Kind:                 kind,
				ExternalPrintID:      &ext,
				ReportRevision:       rev,
				Payload:              raw},
		},
	)
	check("ingest "+string(kind), err)
	if rc[0].Status != "accepted" {
		reason := ""
		if rc[0].ReasonCode != nil {
			reason = *rc[0].ReasonCode
		}
		log.Fatalf("event %s not accepted: %s %s", kind, rc[0].Status, reason)
	}
}

var fdmFiles = []string{
	"gearbox_housing_v3",
	"sensor_bracket",
	"drone_arm_left",
	"rpi_enclosure",
	"cable_clips_x20",
	"thesis_prototype_a",
	"handle_proto",
	"test_coupon_petg",
	"replacement_knob",
	"lens_holder",
	"planetary_gear_test",
	"turbine_blade",
	"impeller_v2",
	"phone_stand",
	"name_badges",
	"spacer_rings",
	"chassis_plate",
	"hinge_set",
}

// printRun simulates a print and returns the observed run id.
func (s *seeder) printRun(
	m *mach,
	start, end time.Time,
	terminal string,
	file string,
	report *float64,
	slotExt string,
) uuid.UUID {
	run := ids.New()
	ext := "sim-" + run.String()[:8]
	f := file + ".gcode.3mf"
	total := end.Sub(start)
	s.ingest(m, run, ext, "operational_state", start, map[string]any{"state": "printing", "fileName": f}, nil)
	for _, pc := range []int{25, 50, 75} {
		at := start.Add(total * time.Duration(pc) / 100)
		s.ingest(
			m,
			run,
			ext,
			"progress",
			at,
			map[string]any{
				"state":            "printing",
				"percent":          pc,
				"remainingSeconds": int(end.Sub(at).Seconds()),
				"fileName":         f,
			},
			nil,
		)
	}
	s.ingest(m, run, ext, "terminal_outcome", end, map[string]any{"outcome": terminal}, nil)
	if report != nil {
		p := map[string]any{"quantityGrams": f1(*report), "quantityBasis": "estimated"}
		if slotExt != "" {
			p["slotExternalId"] = slotExt
		}
		s.ingest(m, run, ext, "consumption_report", end.Add(20*time.Second), p, ptr(int64(1)))
	}
	return run
}

// seedProcessJobs records a few jobs on the embroidery machine, the UV printer,
// the laser cutter (cm2 plywood) and the plotter so every process has data.
func (s *seeder) seedProcessJobs() {
	type use struct {
		name string
		qty  string
	}
	type job struct {
		machine  string
		title    string
		customer party
		daysAgo  int
		minutes  int
		measures machinelogbook.RunMeasures
		uses     []use
	}
	stock := map[string]struct {
		qty, price float64
	}{
		"Tear-away stabilizer": {
			50,
			20,
		}, "UV ink Cyan": {200, 90}, "UV ink Magenta": {200, 90}, "UV ink Yellow": {200, 90},
		"UV ink Black": {
			200,
			90,
		}, "UV ink White": {300, 140}, "DTF sticker paper A4": {20000, 60}, "Roll-to-film 30 cm": {30, 75},
		"Birch plywood 4 mm sheet": {40000, 45}, "Vinyl foil matt white": {30000, 35},
	}
	bought := map[string]bool{}
	jobs := []job{
		{
			"embroidery",
			"Fachschaft polo logo",
			s.orgs["fs"],
			9,
			38,
			machinelogbook.RunMeasures{"stitches": 12400},
			[]use{{"Tear-away stabilizer", "0.4"}},
		},
		{
			"embroidery",
			"Workshop patches",
			s.custs[2],
			4,
			72,
			machinelogbook.RunMeasures{"stitches": 31250},
			[]use{{"Tear-away stabilizer", "0.9"}},
		},
		{
			"uv",
			"Phone case batch",
			s.custs[4],
			7,
			55,
			nil,
			[]use{
				{"UV ink Cyan", "0.45"},
				{"UV ink Magenta", "0.62"},
				{"UV ink Yellow", "0.38"},
				{"UV ink Black", "1.20"},
				{"UV ink White", "1.85"},
				{"DTF sticker paper A4", "180"},
			},
		},
		{
			"uv",
			"Sticker sheets",
			s.orgs["startup"],
			2,
			41,
			nil,
			[]use{
				{"UV ink Cyan", "0.20"},
				{"UV ink Black", "0.75"},
				{"UV ink White", "0.90"},
				{"DTF sticker paper A4", "420"},
				{"Roll-to-film 30 cm", "0.5"},
			},
		},
		{"laser", "Birch coasters", s.custs[6], 5, 25, nil, []use{{"Birch plywood 4 mm sheet", "1450"}}},
		{"plotter", "Window vinyl lettering", s.custs[8], 3, 18, nil, []use{{"Vinyl foil matt white", "2400"}}},
	}
	op := s.supervisors[0]
	for i, j := range jobs {
		m := s.machines[j.machine]
		end := s.now.Add(-time.Duration(j.daysAgo)*24*time.Hour - time.Duration(i)*time.Hour)
		start := end.Add(-time.Duration(j.minutes) * time.Minute)
		var usages []machinelogbook.UsageInput
		for _, u := range j.uses {
			if !bought[u.name] {
				bought[u.name] = true
				st := stock[u.name]
				s.purchase(u.name, st.qty, st.price, start.Add(-48*time.Hour), "Makerspace supplier", 3)
			}
			usages = append(
				usages,
				machinelogbook.UsageInput{
					MaterialID:    s.mats[u.name].id,
					Ownership:     "makerspace",
					Quantity:      u.qty,
					QuantityBasis: "actual",
				},
			)
		}
		job, err := s.ml.CreateManualJob(
			s.ctx,
			s.actor,
			machinelogbook.JobInput{
				MachineID:        m.id,
				Title:            ptr(j.title),
				StartsAt:         start,
				EndsAt:           end,
				Customer:         j.customer.ref(),
				OperatorPersonID: op,
				Outcome:          "successful",
				Usages:           usages,
				Measures:         j.measures,
			},
			nil,
		)
		check("process job "+j.title, err)
		s.jobs = append(
			s.jobs,
			jobRec{
				id:         job.ID,
				customer:   j.customer,
				outcome:    "successful",
				incomplete: job.PricingStatus != "complete",
				ends:       end,
				machine:    m.name,
			},
		)
	}
}

func (s *seeder) unlinkedPrints() {
	x1c, p1s := s.machines["x1c"], s.machines["p1s"]
	rep := func(m *mach, i int, q float64) (*float64, string) { return &q, m.slots[i].ext }
	r, e := rep(p1s, 0, 68.4)
	s.printRun(p1s, s.ago(75*time.Hour), s.ago(72*time.Hour), "completed", "bracket_batch_a", r, e)
	r, e = rep(p1s, 1, 94.0)
	s.printRun(p1s, s.ago(29*time.Hour), s.ago(26*time.Hour), "completed", "enclosure_lid", r, e)
	r, e = rep(x1c, 3, 21.7)
	s.printRun(x1c, s.ago(49*time.Hour), s.ago(48*time.Hour+20*time.Minute), "failed", "turbine_hub_v2", r, e)
	// currently printing on X1C (no terminal event)
	m := x1c
	run := ids.New()
	ext := "sim-" + run.String()[:8]
	f := "gearbox_housing_v4.gcode.3mf"
	start := s.ago(55 * time.Minute)
	s.ingest(m, run, ext, "operational_state", start, map[string]any{"state": "printing", "fileName": f}, nil)
	s.ingest(
		m,
		run,
		ext,
		"progress",
		s.ago(2*time.Minute),
		map[string]any{"state": "printing", "percent": 34, "remainingSeconds": 6300, "fileName": f},
		nil,
	)
}

func (s *seeder) finishPrints() {
	cid := s.connCtx.ID
	hb := func(m *mach, state printerconnectors.AssignmentState, code *string) printerconnectors.AssignmentHealth {
		return printerconnectors.AssignmentHealth{
			AssignmentID:                m.assign,
			AppliedConfigurationVersion: m.cfgVer,
			State:                       state,
			ErrorCode:                   code,
		}
	}
	c, err := s.pc.Get(s.ctx, s.actor, cid)
	check("connector get", err)
	_, err = s.pc.Heartbeat(
		s.ctx,
		s.connCtx,
		printerconnectors.Heartbeat{
			SoftwareVersion:              "devseed-1.0.0",
			HealthState:                  "degraded",
			ProtocolVersion:              1,
			AppliedConfigurationRevision: c.ConfigurationRevision,
			HealthSummary: ptr(
				"P1S reports intermittent MQTT timeouts",
			),
			Assignments: []printerconnectors.AssignmentHealth{
				hb(s.machines["x1c"], printerconnectors.AssignmentConnected, nil),
				hb(s.machines["p1s"], printerconnectors.AssignmentDegraded, ptr("mqtt_timeout")),
			},
		},
	)
	check("heartbeat", err)
}
