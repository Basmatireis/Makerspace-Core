package main

import (
	"log"
	"sort"
	"strconv"
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
		var extras []orders.OrderItemInput
		if manual {
			extras = append(extras, orders.OrderItemInput{
				Kind:        "manual",
				Description: "Design consultation",
				Quantity:    "0.5",
				Unit:        "h",
				UnitPrice:   "20.00",
			})
		}
		return s.draftOrder(s.orders, c, mode, idxs, extras)
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
	// The current scenarios below keep their jobs; the history before them bills the rest.
	i1 := take(ts[0], 3)
	fsJobs := take(s.orgs["fs"], 3)
	chairJobs := take(s.orgs["chair"], 4)
	startupJobs := take(s.orgs["startup"], 2)
	i5 := take(ts[1], 2)
	i6 := take(ts[2], 2)
	// The current scenarios are paid on the last weekday before today (O6 today once the makerspace is open); the
	// history ends the day before, so its counts never miss a payment booked after them.
	recent := s.dayOf(s.now).AddDate(0, 0, -1)
	for !weekday(recent) {
		recent = recent.AddDate(0, 0, -1)
	}
	s.orderHistory(recent)
	paidO2 := recent.Add(11*time.Hour + time.Duration(s.rng.Intn(90))*time.Minute).UTC()
	paidO1 := recent.Add(15*time.Hour + time.Duration(s.rng.Intn(60))*time.Minute).UTC()
	paidO6 := recent.Add(17 * time.Hour).UTC()
	if opened := s.dayOf(s.now).Add(openFrom); weekday(opened) && s.now.After(opened.Add(30*time.Minute)) {
		open := min(s.now.Sub(opened), openUntil-openFrom) - 10*time.Minute
		paidO6 = opened.Add(time.Duration(s.rng.Int63n(int64(open)))).Truncate(time.Minute).UTC()
	}
	// O1: student, paid in cash
	o := build(ts[0], i1, "immediate", false)
	finalize(o, []orders.PaymentInput{{Method: "cash", Amount: sumItems(o), OccurredAt: paidO1}})
	// O2: Fachschaft, partial card payment
	o = build(s.orgs["fs"], fsJobs, "deferred", false)
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
					OccurredAt:        paidO2,
					ExternalSource:    "terminal-1",
					ExternalReference: "TX-" + s.randHex(6),
				},
			},
			nil,
		)
		check("partial payment", err)
	}
	// O3: Lehrstuhl, unpaid, with manual item
	o = build(s.orgs["chair"], chairJobs, "deferred", true)
	finalize(o, nil)
	// O4: Startup, unpaid; job changed afterwards -> outdated
	idx := startupJobs
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
	o = build(ts[1], i5, "deferred", false)
	_ = o
	// O6: second student paid in cash
	o = build(ts[2], i6, "immediate", false)
	finalize(o, []orders.PaymentInput{{Method: "cash", Amount: sumItems(o), OccurredAt: paidO6}})
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

// draftOrder creates a draft for c with the given jobs and extra (manual or stock article) lines.
func (s *seeder) draftOrder(
	svc *orders.Service,
	c party,
	mode string,
	jobs []int,
	extras []orders.OrderItemInput,
) orders.Order {
	o, err := svc.Create(
		s.ctx,
		s.actor,
		orders.OrderDraftInput{
			Customer:        &orders.OrderCustomer{Kind: orders.CustomerKind(c.kind), ID: c.id},
			FulfillmentMode: orders.FulfillmentMode(mode),
		},
		nil,
	)
	check("order create", err)
	for _, i := range jobs {
		job, err := s.ml.GetJob(s.ctx, s.actor, s.jobs[i].id)
		check("get job", err)
		o, err = svc.ChangeItem(
			s.ctx,
			s.actor,
			o.ID,
			uuid.Nil,
			orders.OrderItemInput{
				Kind:               orders.ItemMachineJob,
				MachineJobID:       job.ID,
				ExpectedJobVersion: job.Version,
				ExpectedVersion:    o.Version,
			},
			orders.ItemActionAdd,
			nil,
		)
		check("order add item", err)
	}
	for _, extra := range extras {
		extra.ExpectedVersion = o.Version
		o, err = svc.ChangeItem(s.ctx, s.actor, o.ID, uuid.Nil, extra, orders.ItemActionAdd, nil)
		check("order extra item", err)
	}
	return o
}

// ---------- order and payment history ----------

// historyMonths is how far back the billed order and payment history reaches. It holds up to historyJobOrders
// orders of jobs and at least historyOtherOrders of workshop fees and kits, besides the stock article sales.
const (
	historyMonths      = 4
	historyJobOrders   = 60
	historyOtherOrders = 8
)

// Payments are taken during opening hours; bank deposits follow at closing and counts in the evening, so a count
// always comes after the entries of its day.
const (
	openFrom      = 10 * time.Hour
	openUntil     = 17*time.Hour + 30*time.Minute
	depositHour   = 18*time.Hour + 30*time.Minute
	countHour     = 19*time.Hour + 20*time.Minute
	registerFloat = 60 // euros left in the register after a bank deposit
	minDeposit    = 10 // smaller weekly takings wait for the next week
)

type payPlan string

const (
	payCash    payPlan = "cash"
	payCard    payPlan = "card"
	paySplit   payPlan = "split" // part paid in cash at pickup, the rest on a later visit
	payInvoice payPlan = "invoice"
)

type histSpecial string

const (
	specialNone        histSpecial = ""
	specialRefund      histSpecial = "refund"       // returned unused, cash refunded, order reversed
	specialWrongMethod histSpecial = "wrong_method" // recorded as cash, paid by card
	specialWrongAmount histSpecial = "wrong_amount" // cash amount mistyped, corrected
)

type histOrder struct {
	cust    party
	jobs    []int
	extras  []orders.OrderItemInput
	at      time.Time // finalized and first paid
	later   time.Time // second payment of a split
	refund  time.Time
	pay     payPlan
	special histSpecial
	id      uuid.UUID
}

type stockArticle struct {
	name, qty string
	id        uuid.UUID
	left      decimal.Decimal
}

func (s *seeder) dayOf(t time.Time) time.Time {
	l := t.In(s.loc)
	return time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, s.loc)
}

func weekday(day time.Time) bool {
	return day.Weekday() != time.Saturday && day.Weekday() != time.Sunday
}

// openTime is a random minute during opening hours on the first weekday that has one after t.
func (s *seeder) openTime(t time.Time) time.Time {
	for day := s.dayOf(t); ; day = day.AddDate(0, 0, 1) {
		if !weekday(day) {
			continue
		}
		lo, hi := day.Add(openFrom), day.Add(openUntil)
		if t.After(lo) {
			lo = t.Add(10 * time.Minute)
		}
		if lo.Before(hi) {
			return lo.Add(time.Duration(s.rng.Int63n(int64(hi.Sub(lo))))).Truncate(time.Minute).UTC()
		}
	}
}

// ordersAt is the orders service whose stock sales and restocks are dated t.
func (s *seeder) ordersAt(t time.Time) *orders.Service {
	return orders.NewService(s.pool, s.mlAt(t)).WithLocation(s.loc)
}

// stockArticles are the seeded parts with the loose stock this run may sell.
func (s *seeder) stockArticles() []*stockArticle {
	var out []*stockArticle
	for _, a := range [][2]string{
		{"M3 heat-set insert", "20"},
		{"M3x8 screw", "30"},
		{"Bike chain 8-speed", "1"},
		{"Brake caliper", "1"},
	} {
		id, ok := s.existing(
			"SELECT id FROM materials WHERE lower(name) = lower($1) AND unit = 'piece' AND active AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
			a[0],
		)
		if !ok {
			continue
		}
		m, err := s.ml.GetMaterial(s.ctx, s.actor, id)
		check("get article", err)
		out = append(
			out,
			&stockArticle{name: a[0], qty: a[1], id: id, left: decimal.RequireFromString(m.UnassignedQuantity)},
		)
	}
	return out
}

// sell returns an order line for the article while its loose stock still covers it.
func (a *stockArticle) sell() (orders.OrderItemInput, bool) {
	q := decimal.RequireFromString(a.qty)
	if a.left.LessThan(q) {
		return orders.OrderItemInput{}, false
	}
	a.left = a.left.Sub(q)
	return orders.OrderItemInput{Kind: orders.ItemInventory, MaterialID: a.id, Quantity: a.qty}, true
}

// customLines are manual order lines: the first three go with jobs, the last two are sold on their own.
var customLines = []orders.OrderItemInput{
	{Kind: orders.ItemManual, Description: "Design consultation", Quantity: "0.5", Unit: "h", UnitPrice: "20.00"},
	{Kind: orders.ItemManual, Description: "Express handling", Quantity: "1", Unit: "piece", UnitPrice: "5.00"},
	{Kind: orders.ItemManual, Description: "Sanding and post-processing", Quantity: "0.25", Unit: "h", UnitPrice: "16.00"},
	{
		Kind:        orders.ItemManual,
		Description: "Laser cutting introduction workshop",
		Quantity:    "1",
		Unit:        "session",
		UnitPrice:   "15.00",
	},
	{Kind: orders.ItemManual, Description: "Soldering starter kit", Quantity: "1", Unit: "piece", UnitPrice: "8.50"},
}

// orderHistory bills the finished, priced jobs of the last months that no current order holds, with some stock
// articles and custom lines, and records their payments, the cash movements and the monthly counts in the order
// they happened. Running in time order means each count sees exactly what was booked before it and a withdrawal
// never takes more than the register holds.
// The history covers whole days from historyMonths ago up to until (exclusive).
func (s *seeder) orderHistory(until time.Time) {
	from := s.dayOf(s.now).AddDate(0, -historyMonths, 0)
	articles := s.stockArticles()
	partsFrom := s.dateOf(9, 20).Add(24 * time.Hour)

	// Jobs that can be billed, per customer.
	byCust := map[uuid.UUID][]int{}
	var custOrder []party
	for i, j := range s.jobs {
		if j.used || j.incomplete || (j.outcome != "successful" && j.outcome != "partial_failure") ||
			j.ends.Before(from.AddDate(0, 0, -7)) || !j.ends.Before(until.Add(-24*time.Hour)) {
			continue
		}
		if len(byCust[j.customer.id]) == 0 {
			custOrder = append(custOrder, j.customer)
		}
		byCust[j.customer.id] = append(byCust[j.customer.id], i)
	}
	var plan []*histOrder
	for _, c := range custOrder {
		idx := byCust[c.id]
		sort.SliceStable(idx, func(a, b int) bool { return s.jobs[idx[a]].ends.Before(s.jobs[idx[b]].ends) })
		for k := 0; k < len(idx); {
			group := []int{idx[k]}
			k++
			for k < len(idx) && len(group) < 3 && s.jobs[idx[k]].ends.Sub(s.jobs[group[0]].ends) < 6*24*time.Hour {
				group = append(group, idx[k])
				k++
			}
			last := s.jobs[group[len(group)-1]].ends
			at := s.openTime(last.Add(time.Duration(s.rng.Intn(48)) * time.Hour))
			if at.Before(from) || !at.Before(until) {
				continue
			}
			h := &histOrder{cust: c, jobs: group, at: at}
			if s.rng.Float64() < 0.15 {
				h.extras = append(h.extras, customLines[s.rng.Intn(3)])
			}
			if at.After(partsFrom) && len(articles) >= 2 && s.rng.Float64() < 0.3 {
				if line, ok := articles[s.rng.Intn(2)].sell(); ok {
					h.extras = append(h.extras, line)
				}
			}
			plan = append(plan, h)
		}
	}
	// Keep the number of orders steady whatever the seed planned: surplus jobs stay unbilled, a short year gets
	// more workshop fees and kits.
	for len(plan) > historyJobOrders {
		i := s.rng.Intn(len(plan))
		plan = append(plan[:i], plan[i+1:]...)
	}
	// Orders without jobs: workshop fees and kits over the whole period, stock articles once they are in.
	var people []party
	for _, c := range s.custs {
		if c.kind == "person" {
			people = append(people, c)
		}
	}
	span := until.Sub(from) - 24*time.Hour
	for range max(historyOtherOrders, historyJobOrders+historyOtherOrders-len(plan)) {
		at := s.openTime(from.Add(time.Duration(s.rng.Int63n(int64(span)))))
		line := customLines[3+s.rng.Intn(2)]
		if at.Before(until) {
			plan = append(
				plan,
				&histOrder{cust: people[s.rng.Intn(len(people))], at: at, extras: []orders.OrderItemInput{line}},
			)
		}
	}
	if partsFrom.Before(until) {
		for i := 0; i < 6 && len(articles) > 0; i++ {
			a := articles[i%len(articles)]
			at := s.openTime(partsFrom.Add(time.Duration(s.rng.Int63n(int64(until.Sub(partsFrom))))))
			if a.name == "Brake caliper" {
				// Sold soon after it came in, so the return a few days later still falls into the history.
				at = s.openTime(partsFrom.Add(time.Duration(s.rng.Intn(48)) * time.Hour))
			}
			if !at.Before(until) {
				continue
			}
			line, ok := a.sell()
			if !ok {
				continue
			}
			h := &histOrder{cust: people[s.rng.Intn(len(people))], at: at, extras: []orders.OrderItemInput{line}}
			if a.name == "Brake caliper" {
				h.special = specialRefund
			}
			plan = append(plan, h)
		}
	}
	sort.SliceStable(plan, func(a, b int) bool { return plan[a].at.Before(plan[b].at) })
	s.planPayments(plan, from, until)

	var events []event
	add := func(at time.Time, fn func()) { events = append(events, event{at, fn}) }
	for _, h := range plan {
		add(h.at, func() { s.billHistoric(h) })
		if h.pay == paySplit {
			add(h.later, func() { s.payRest(h) })
		}
		if h.special == specialRefund {
			add(h.refund, func() { s.refundHistoric(h) })
		}
	}
	s.cashMovementEvents(from, until, add)
	counts := s.cashCountEvents(from, until, add)
	sort.SliceStable(events, func(a, b int) bool { return events[a].at.Before(events[b].at) })
	for _, e := range events {
		e.fn()
	}
	log.Printf("order history: %d orders, %d cash counts, %d events", len(plan), counts, len(events))
}

// planPayments decides how each historic order is paid: mostly cash, some card, a few over two visits, a few wiRef
// invoices for organizations, and the three corrections of the cash register.
func (s *seeder) planPayments(plan []*histOrder, from, until time.Time) {
	invoices := 0
	invoiceBefore := until.AddDate(0, 0, -21)
	refund := func(h *histOrder) bool {
		h.refund = s.openTime(h.at.Add(time.Duration(2+s.rng.Intn(3)) * 24 * time.Hour))
		if !h.refund.Before(until) {
			return false
		}
		h.pay, h.special = payCash, specialRefund
		return true
	}
	refunded := false
	for _, h := range plan {
		billed := h.cust.cat == "org" && h.cust.id != s.orgs["fs"].id
		switch {
		case billed && invoices < 3 && h.at.Before(invoiceBefore) && len(h.jobs) > 0:
			h.pay = payInvoice
			invoices++
		case billed:
			h.pay = payCard
		default:
			switch r := s.rng.Float64(); {
			case r < 0.62:
				h.pay = payCash
			case r < 0.78:
				h.pay = payCard
			default:
				h.pay = paySplit
			}
		}
		if h.special == specialRefund {
			h.special = specialNone
			if !refunded {
				refunded = refund(h)
			}
		}
		if h.pay == paySplit {
			h.later = s.openTime(h.at.Add(time.Duration(4+s.rng.Intn(10)) * 24 * time.Hour))
			if !h.later.Before(until) {
				h.pay = payCash
			}
		}
	}
	// Without the article return (a database whose parts are sold out), a print paid in cash is refunded instead.
	for _, h := range plan {
		if !refunded && h.at.After(from.AddDate(0, 0, 45)) && h.pay == payCash && h.cust.kind == "person" &&
			len(h.jobs) > 0 {
			refunded = refund(h)
		}
	}
	// A cash receipt that was really paid by card about a month in, and a mistyped cash amount two months in.
	pick := func(after time.Time, special histSpecial) {
		for _, h := range plan {
			if h.at.After(after) && h.pay == payCash && h.special == specialNone && len(h.jobs) > 0 {
				h.special = special
				return
			}
		}
	}
	pick(from.AddDate(0, 1, 0), specialWrongMethod)
	pick(from.AddDate(0, 2, 0), specialWrongAmount)
}

func (s *seeder) card(amount string, at time.Time) orders.PaymentInput {
	return orders.PaymentInput{
		Method:            orders.PaymentCard,
		Amount:            amount,
		OccurredAt:        at,
		ExternalSource:    "terminal-1",
		ExternalReference: "TX-" + s.randHex(6),
	}
}

// billHistoric creates, finalizes and pays one historic order at its time.
func (s *seeder) billHistoric(h *histOrder) {
	svc := s.ordersAt(h.at)
	mode := "immediate"
	if h.pay == paySplit || h.pay == payInvoice || h.cust.cat == "org" {
		mode = "deferred"
	}
	o := s.draftOrder(svc, h.cust, mode, h.jobs, h.extras)
	total := decimal.RequireFromString(sumItems(o))
	var pays []orders.PaymentInput
	if total.IsPositive() {
		switch h.pay {
		case payCash:
			amount := total
			if h.special == specialWrongAmount {
				// A digit slipped when typing the amount; correctHistoric books the real one.
				amount = total.Sub(decimal.NewFromInt(10))
				if !amount.IsPositive() {
					amount = total.Div(decimal.NewFromInt(2)).Round(2)
				}
			}
			pays = append(
				pays,
				orders.PaymentInput{Method: orders.PaymentCash, Amount: amount.StringFixed(2), OccurredAt: h.at},
			)
		case payCard:
			pays = append(pays, s.card(total.StringFixed(2), h.at))
		case paySplit:
			part := total.Div(decimal.NewFromInt(2)).Floor()
			if part.LessThan(decimal.NewFromInt(1)) {
				part = total
			}
			pays = append(
				pays,
				orders.PaymentInput{Method: orders.PaymentCash, Amount: part.StringFixed(2), OccurredAt: h.at},
			)
		case payInvoice:
		}
	}
	o, err := svc.Command(
		s.ctx,
		s.actor,
		o.ID,
		orders.OrderCommand{OperationKey: ids.New(), ExpectedVersion: o.Version, Payments: pays},
		orders.OrderActionFinalize,
		nil,
	)
	check("history finalize", err)
	h.id = o.ID
	switch {
	case !total.IsPositive():
	case h.special == specialWrongMethod || h.special == specialWrongAmount:
		s.correctHistoric(o, h)
	case h.pay == payInvoice:
		s.invoiceHistoric(o, h)
	}
}

// receiptOf is the payment of the order's first positive allocation.
func receiptOf(o orders.Order) uuid.UUID {
	for _, a := range o.Allocations {
		if a.PaymentID != nil && decimal.RequireFromString(a.Amount).IsPositive() {
			return *a.PaymentID
		}
	}
	return uuid.Nil
}

// correctHistoric reverses the cash receipt as a recording error and books what really happened, both at the time
// of the original receipt.
func (s *seeder) correctHistoric(o orders.Order, h *histOrder) {
	payment := receiptOf(o)
	if payment == uuid.Nil {
		return
	}
	replacement := orders.PaymentInput{Method: orders.PaymentCash, Amount: o.TotalAmount, OccurredAt: h.at}
	reason := "Amount mistyped; the customer paid the full total in cash"
	if h.special == specialWrongMethod {
		replacement = s.card(o.TotalAmount, h.at)
		reason = "Paid by card at the terminal, recorded as cash by mistake"
	}
	_, err := s.orders.ReversePayment(
		s.ctx,
		s.actor,
		payment,
		orders.ReversePaymentCommand{
			OperationKey:    ids.New(),
			ExpectedVersion: o.Version,
			Reversal: orders.PaymentReversalInput{
				PaymentID:  payment,
				ReasonKind: orders.ReversalRecordingError,
				Reason:     reason,
				OccurredAt: h.at,
			},
			ReplacementPayment: &replacement,
		},
		nil,
	)
	check("history correction", err)
}

// invoiceHistoric asks wiRef to invoice the order and forwards the request. Forwarding settles the balance with a
// wiRef payment, which the service dates when it is recorded rather than at the forwarding date.
func (s *seeder) invoiceHistoric(o orders.Order, h *histOrder) {
	day := s.dayOf(h.at)
	r, err := s.orders.CreateRequest(
		s.ctx,
		s.actor,
		o.ID,
		orders.CreateInvoiceRequest{
			OperationKey:    ids.New(),
			ExpectedVersion: o.Version,
			Details: orders.InvoiceRequestDetails{
				AddressLine1:           "Inffeldgasse 25",
				PostalCode:             "8010",
				Locality:               "Graz",
				CountryCode:            "AT",
				ContactName:            "Office " + h.cust.name,
				ServiceStartsOn:        s.dayOf(s.jobs[h.jobs[0]].ends).Format(time.DateOnly),
				ServiceEndsOn:          day.Format(time.DateOnly),
				ServiceDescription:     "Machine use in the makerspace (3D printing and laser cutting)",
				PurchaseOrderReference: "PO-" + strconv.Itoa(4100+s.rng.Intn(800)),
			},
		},
		nil,
	)
	check("invoice request", err)
	r, err = s.orders.RequestCommand(
		s.ctx,
		s.actor,
		r.ID,
		orders.InvoiceRequestCommand{
			OperationKey:    ids.New(),
			ExpectedVersion: r.Version,
			EffectiveAt:     h.at.Add(time.Hour),
		},
		orders.InvoiceActionSubmit,
		nil,
	)
	check("invoice submit", err)
	_, err = s.orders.RequestCommand(
		s.ctx,
		s.actor,
		r.ID,
		orders.InvoiceRequestCommand{
			OperationKey:      ids.New(),
			ExpectedVersion:   r.Version,
			EffectiveAt:       s.openTime(h.at.Add(48 * time.Hour)),
			ExternalReference: "RE-" + strconv.Itoa(day.Year()) + "-" + strconv.Itoa(20000+s.rng.Intn(9000)),
		},
		orders.InvoiceActionForward,
		nil,
	)
	check("invoice forward", err)
}

// payRest settles the open balance of a split order on the customer's next visit.
func (s *seeder) payRest(h *histOrder) {
	o, err := s.orders.Get(s.ctx, s.actor, h.id)
	check("get order", err)
	if !decimal.RequireFromString(o.OutstandingAmount).IsPositive() {
		return
	}
	p := orders.PaymentInput{Method: orders.PaymentCash, Amount: o.OutstandingAmount, OccurredAt: h.later}
	if s.rng.Float64() < 0.2 {
		p = s.card(o.OutstandingAmount, h.later)
	}
	_, err = s.orders.RecordPayment(
		s.ctx,
		s.actor,
		o.ID,
		orders.RecordOrderPayment{OperationKey: ids.New(), ExpectedVersion: o.Version, Payment: p},
		nil,
	)
	check("history remainder", err)
}

// refundHistoric takes back an unused article: the cash goes back to the customer and the order is reversed,
// which returns the article to stock.
func (s *seeder) refundHistoric(h *histOrder) {
	o, err := s.orders.Get(s.ctx, s.actor, h.id)
	check("get order", err)
	payment := receiptOf(o)
	if payment == uuid.Nil {
		return
	}
	reason, refund := "Returned unused: wrong model for the customer's bike", "Article returned unused; cash refunded"
	if len(h.jobs) > 0 {
		reason, refund = "Print unusable: layers split along the part", "Print unusable; cash refunded"
	}
	_, err = s.ordersAt(h.refund).Command(
		s.ctx,
		s.actor,
		o.ID,
		orders.OrderCommand{
			OperationKey:    ids.New(),
			ExpectedVersion: o.Version,
			Reason:          reason,
			Reversals: []orders.PaymentReversalInput{{
				PaymentID:  payment,
				ReasonKind: orders.ReversalRefund,
				Reason:     refund,
				OccurredAt: h.refund,
			}},
		},
		orders.OrderActionReverse,
		nil,
	)
	check("history refund", err)
}

// registerHolds is the cash the register should hold right after t.
func (s *seeder) registerHolds(t time.Time) decimal.Decimal {
	at := t.Add(time.Microsecond)
	r, err := s.orders.CashRegister(s.ctx, s.actor, &at)
	check("cash register", err)
	return decimal.RequireFromString(r.Expected)
}

// registerSpare is what a withdrawal at t can take: the least the register holds from t on. On a fresh database
// nothing is booked after t yet; on a repeated run the earlier run's later entries must not go short.
func (s *seeder) registerSpare(t time.Time) decimal.Decimal {
	spare := s.registerHolds(t)
	var later *string
	check("register low", s.pool.QueryRow(
		s.ctx,
		`SELECT min(balance)::text FROM (SELECT occurred_at, sum(effect) OVER (ORDER BY occurred_at, sort_rank, reference) AS balance
		FROM cash_register_entries) entries WHERE occurred_at > $1`,
		t,
	).Scan(&later))
	if later != nil {
		spare = decimal.Min(spare, decimal.RequireFromString(*later))
	}
	return spare
}

func (s *seeder) moveCash(
	kind orders.CashMovementKind,
	reason orders.CashMovementReason,
	amount decimal.Decimal,
	note string,
	at time.Time,
) {
	_, err := s.orders.CreateCashMovement(
		s.ctx,
		s.actor,
		orders.CashMovementInput{
			OperationKey: ids.New(),
			Kind:         kind,
			Amount:       amount.StringFixed(2),
			Reason:       reason,
			Note:         note,
			OccurredAt:   at,
		},
		nil,
	)
	check("cash movement", err)
}

// fives rounds down to whole multiples of five euros: notes are deposited, coins stay in the register.
func fives(v decimal.Decimal) decimal.Decimal {
	return v.Div(decimal.NewFromInt(5)).Floor().Mul(decimal.NewFromInt(5))
}

// cashMovementEvents plans two change float deposits, a bank deposit at the end of every week and one transfer to
// the safe at the start of the quiet summer weeks. Withdrawals are sized when they run, from what the register
// holds then.
func (s *seeder) cashMovementEvents(from, until time.Time, add func(time.Time, func())) {
	first := s.dayOf(s.openTime(from)).Add(openFrom - 15*time.Minute).UTC()
	add(first, func() {
		s.moveCash(orders.CashDeposit, orders.CashReasonFloat, decimal.NewFromInt(150), "Change float from the safe", first)
	})
	second := s.dayOf(s.openTime(from.AddDate(0, 0, 45))).Add(openFrom - 10*time.Minute).UTC()
	add(second, func() {
		s.moveCash(orders.CashDeposit, orders.CashReasonFloat, decimal.NewFromInt(50), "Coins for change", second)
	})
	safe := false
	for day := from; day.Before(until); day = day.AddDate(0, 0, 1) {
		if day.Weekday() != time.Friday {
			continue
		}
		at := day.Add(depositHour).Add(time.Duration(s.rng.Intn(20)) * time.Minute).UTC()
		if !safe && day.Month() == time.August {
			safe = true
			add(at, func() {
				if amount := fives(s.registerSpare(at).Sub(decimal.NewFromInt(40))); amount.IsPositive() {
					s.moveCash(orders.CashWithdrawal, orders.CashReasonSafe, amount, "Summer break: cash kept in the safe", at)
				}
			})
			continue
		}
		add(at, func() {
			amount := fives(s.registerSpare(at).Sub(decimal.NewFromInt(registerFloat)))
			if amount.GreaterThanOrEqual(decimal.NewFromInt(minDeposit)) {
				s.moveCash(orders.CashWithdrawal, orders.CashReasonBankDeposit, amount, "", at)
			}
		})
	}
}

// cashCountEvents plans a count on the last weekday of every month of the history. Two of them differ: a small
// shortfall from a counting error and a surplus from a sale that was not entered.
func (s *seeder) cashCountEvents(from, until time.Time, add func(time.Time, func())) int {
	// Counts are recorded in time order; a repeated run only counts after the counts that are already there.
	var latest *time.Time
	check("latest count", s.pool.QueryRow(s.ctx, "SELECT max(counted_at) FROM cash_counts").Scan(&latest))
	n := 0
	for month := time.Date(from.Year(), from.Month(), 1, 0, 0, 0, 0, s.loc); month.Before(until); month = month.AddDate(0, 1, 0) {
		day := month.AddDate(0, 1, -1)
		for !weekday(day) {
			day = day.AddDate(0, 0, -1)
		}
		if day.Before(from) || !day.Before(until) {
			continue
		}
		at := day.Add(countHour).Add(time.Duration(s.rng.Intn(25)) * time.Minute).UTC()
		if latest != nil && !at.After(*latest) {
			continue
		}
		n++
		k := n
		add(at, func() {
			expected := s.registerHolds(at)
			in := orders.CashCountInput{OperationKey: ids.New(), CountedAt: at}
			counted := expected
			switch k {
			case 2:
				counted = expected.Sub(decimal.RequireFromString("2.50"))
				in.Reason = ptr(orders.CountReasonCountingError)
			case 3:
				counted = expected.Add(decimal.RequireFromString("4.00"))
				in.Reason = ptr(orders.CountReasonReceiptNotRecorded)
				in.Note = "Sticker sheets sold at the open day were not entered"
			}
			in.CountedAmount = counted.StringFixed(2)
			_, err := s.orders.RecordCashCount(s.ctx, s.actor, in, nil)
			check("cash count", err)
		})
	}
	return n
}
