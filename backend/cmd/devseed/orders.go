package main

import (
	"log"
	"sort"
	"time"
	_ "time/tzdata"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/orders"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

func (s *seeder) priceAdjustments() {
	get := func(f func(r jobRec) bool) *jobRec {
		for i := range s.jobs {
			if !s.jobs[i].used && !s.jobs[i].incomplete && f(s.jobs[i]) {
				return &s.jobs[i]
			}
		}
		return nil
	}
	apply := func(r *jobRec, kind, val, reason string) {
		if r == nil {
			return
		}
		job, err := s.ml.GetJob(s.ctx, s.actor, r.id)
		check("get job", err)
		_, err = s.mlAt(r.ends.Add(36*time.Hour)).
			SetJobPriceAdjustment(s.ctx, s.actor, r.id, job.Version, machinelogbook.PriceAdjustmentKind(kind), val, reason, nil)
		check("adjust", err)
		r.used = true
	}
	apply(
		get(func(r jobRec) bool { return r.failedRun && r.ends.Before(s.ago(24*time.Hour)) }),
		"discount_percent",
		"100",
		"Print failed due to machine fault; no charge",
	)
	apply(
		get(func(r jobRec) bool { return r.customer.id == s.orgs["fs"].id && r.outcome == "successful" }),
		"discount_percent",
		"50",
		"Student council sponsorship",
	)
	apply(
		get(func(r jobRec) bool { return r.customer.cat == "student" && r.outcome == "partial_failure" }),
		"discount_amount",
		"1.00",
		"Goodwill after partial failure",
	)
	apply(get(func(r jobRec) bool {
		return r.customer.cat == "student" && r.outcome == "successful" && r.machine == s.machines["laser"].name
	}), "fixed", "5.00", "Flat rate for class project")
	for i := range s.jobs {
		s.jobs[i].used = false
	}
}

func (s *seeder) createOrders() {
	byCust := map[uuid.UUID][]int{}
	for i, j := range s.jobs {
		if j.outcome == "successful" && !j.incomplete && j.ends.Before(s.ago(6*time.Hour)) {
			byCust[j.customer.id] = append(byCust[j.customer.id], i)
		}
	}
	take := func(c party, n int) []int {
		var out []int
		for _, i := range byCust[c.id] {
			if !s.jobs[i].used && len(out) < n {
				out = append(out, i)
				s.jobs[i].used = true
			}
		}
		return out
	}
	topStudents := func() []party {
		var ps []party
		for _, c := range s.custs {
			if c.cat == "student" && len(byCust[c.id]) >= 2 {
				ps = append(ps, c)
			}
		}
		sort.Slice(ps, func(i, j int) bool { return len(byCust[ps[i].id]) > len(byCust[ps[j].id]) })
		return ps
	}
	build := func(c party, idxs []int, mode string, manual bool) orders.Order {
		o, err := s.orders.Create(
			s.ctx,
			s.actor,
			orders.OrderDraftInput{Customer: &orders.OrderCustomer{Kind: orders.CustomerKind(c.kind), ID: c.id}, FulfillmentMode: orders.FulfillmentMode(mode)},
			nil,
		)
		check("order create", err)
		for _, i := range idxs {
			job, err := s.ml.GetJob(s.ctx, s.actor, s.jobs[i].id)
			check("get job", err)
			o, err = s.orders.ChangeItem(
				s.ctx,
				s.actor,
				o.ID,
				uuid.Nil,
				orders.OrderItemInput{
					Kind:               "machine_job",
					MachineJobID:       job.ID,
					ExpectedJobVersion: job.Version,
					ExpectedVersion:    o.Version,
				},
				"add",
				nil,
			)
			check("order add item", err)
		}
		if manual {
			o, err = s.orders.ChangeItem(
				s.ctx,
				s.actor,
				o.ID,
				uuid.Nil,
				orders.OrderItemInput{
					Kind:            "manual",
					Description:     "Design consultation",
					Quantity:        "0.5",
					Unit:            "h",
					UnitPrice:       "20.00",
					ExpectedVersion: o.Version,
				},
				"add",
				nil,
			)
			check("order manual item", err)
		}
		return o
	}
	finalize := func(o orders.Order, pays []orders.PaymentInput) orders.Order {
		o, err := s.orders.Command(
			s.ctx,
			s.actor,
			o.ID,
			orders.OrderCommand{OperationKey: ids.New(), ExpectedVersion: o.Version, Payments: pays},
			"finalize",
			nil,
		)
		check("order finalize", err)
		return o
	}
	ts := topStudents()
	if len(ts) < 3 {
		log.Fatal("not enough student jobs for orders")
	}
	// O1: student, paid in cash
	i1 := take(ts[0], 3)
	o := build(ts[0], i1, "immediate", false)
	finalize(o, []orders.PaymentInput{{Method: "cash", Amount: sumItems(o), OccurredAt: s.ago(20 * time.Hour)}})
	// O2: Fachschaft, partial card payment
	o = build(s.orgs["fs"], take(s.orgs["fs"], 3), "deferred", false)
	o = finalize(o, nil)
	if d := decimal.RequireFromString(o.TotalAmount); d.GreaterThan(decimal.RequireFromString("1.00")) {
		_, err := s.orders.RecordPayment(
			s.ctx,
			s.actor,
			o.ID,
			orders.RecordOrderPayment{
				OperationKey:    ids.New(),
				ExpectedVersion: o.Version,
				Payment: orders.PaymentInput{
					Method:            "card",
					Amount:            "1.00",
					OccurredAt:        s.ago(30 * time.Hour),
					ExternalSource:    "terminal-1",
					ExternalReference: "TX-" + s.randHex(6),
				},
			},
			nil,
		)
		check("partial payment", err)
	}
	// O3: Lehrstuhl, unpaid, with manual item
	o = build(s.orgs["chair"], take(s.orgs["chair"], 4), "deferred", true)
	finalize(o, nil)
	// O4: Startup, unpaid; job changed afterwards -> outdated
	idx := take(s.orgs["startup"], 2)
	if len(idx) > 0 {
		o = build(s.orgs["startup"], idx, "deferred", false)
		finalize(o, nil)
		job, err := s.ml.GetJob(s.ctx, s.actor, s.jobs[idx[0]].id)
		check("get job", err)
		_, err = s.ml.SetJobPriceAdjustment(
			s.ctx,
			s.actor,
			job.ID,
			job.Version,
			"multiplier",
			"1.5",
			"Rush job surcharge added after invoicing",
			nil,
		)
		check("late adjustment", err)
	} else {
		log.Println("no startup jobs for outdated order")
	}
	// O5: draft for a student
	o = build(ts[1], take(ts[1], 2), "deferred", false)
	_ = o
	// O6: second student paid in cash
	i6 := take(ts[2], 2)
	o = build(ts[2], i6, "immediate", false)
	finalize(o, []orders.PaymentInput{{Method: "cash", Amount: sumItems(o), OccurredAt: s.ago(8 * time.Hour)}})
}

func sumItems(o orders.Order) string {
	t := decimal.Zero
	for _, it := range o.Items {
		if it.RemovedAt == nil {
			t = t.Add(decimal.RequireFromString(it.Amount))
		}
	}
	return t.StringFixed(2)
}
