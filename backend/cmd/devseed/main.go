// Command devseed fills an EMPTY development database with demo data for a
// small/medium university makerspace: people, machines, materials, spools,
// jobs, prints, orders and open day assignments. It writes exclusively through
// the service layer so business rules and audit events apply as they would in
// normal use.
//
// The program refuses to run when machines, materials or machine jobs already
// exist, and it refuses to run when APP_ENV is "production" or "prod".
//
// Run it against the development database with:
//
//	make seed-dev
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"math"
	mrand "math/rand"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/opendays"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/orders"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

type ML = machinelogbook.Service

func check(label string, err error) {
	if err != nil {
		log.Fatalf("FAILED %s: %v", label, err)
	}
}

func ptr[T any](v T) *T { return &v }

func f1(v float64) string { return strconv.FormatFloat(v, 'f', 1, 64) }
func f2(v float64) string { return strconv.FormatFloat(v, 'f', 2, 64) }
func f3(v float64) string { return strconv.FormatFloat(v, 'f', 3, 64) }

type party struct {
	kind string
	id   uuid.UUID
	cat  string // student, staff, external, org
	name string
}

func (p party) ref() machinelogbook.PartyReference {
	return machinelogbook.PartyReference{Kind: p.kind, ID: p.id}
}

type mat struct {
	id   uuid.UUID
	name string
	cat  string
}

type product struct {
	id     uuid.UUID
	mat    string
	name   string
	maker  string
	weight float64
	price  float64
}

type slot struct {
	id   uuid.UUID
	ext  string
	cur  uuid.UUID // currently mounted spool
	reu  *reusable
	gens []gen
	gi   int
	name string
}

type gen struct {
	prod   string
	rotate time.Time // rotate on first job after this time; zero = never
}

type reusable struct {
	id    uuid.UUID
	label string
	slot  *slot
}

type mach struct {
	id      uuid.UUID
	name    string
	typ     string
	fdm     bool
	bambu   bool
	slots   []*slot
	assign  uuid.UUID
	cfgVer  int64
	seq     int64
	busy    [][2]time.Time
	weights []float64
}

func (m *mach) free(a, b time.Time) bool {
	for _, iv := range m.busy {
		if a.Before(iv[1].Add(20*time.Minute)) && b.After(iv[0].Add(-20*time.Minute)) {
			return false
		}
	}
	return true
}

type plan struct {
	m        *mach
	start    time.Time
	end      time.Time
	customer party
	operator uuid.UUID
	outcome  string
	title    *string
	notes    *string
	mode     string // "", "create", "link"
	acrylic  bool
	special  string // running, needs_outcome
}

type jobRec struct {
	id         uuid.UUID
	customer   party
	outcome    string
	incomplete bool
	ends       time.Time
	machine    string
	used       bool
	failedRun  bool
}

type event struct {
	at time.Time
	fn func()
}

type seeder struct {
	ctx      context.Context
	pool     *pgxpool.Pool
	cfg      config.Config
	rng      *mrand.Rand
	actor    authorization.Principal
	people   *people.Service
	accounts *accounts.Service
	ml       *ML
	printing *printing.Service
	pc       *printerconnectors.Service
	orders   *orders.Service
	od       *opendays.Service
	loc      *time.Location
	now      time.Time

	roles       map[string]uuid.UUID
	supervisors []uuid.UUID
	trainees    []uuid.UUID
	custs       []party
	orgs        map[string]party
	mats        map[string]*mat
	prods       map[string]*product
	machines    map[string]*mach
	reus        []*reusable
	connCtx     printerconnectors.Context
	events      []event
	jobs        []jobRec
	idCounter   int
	opWeights   []float64
	spoolSeq    int
}

func main() {
	if env := os.Getenv("APP_ENV"); env == "production" || env == "prod" {
		fmt.Fprintln(os.Stderr, "devseed refuses to run with APP_ENV=production")
		os.Exit(1)
	}
	ctx := context.Background()
	cfg, err := config.Load()
	check("config", err)
	pool, err := database.Open(ctx, cfg.DatabaseURL)
	check("db", err)
	defer pool.Close()

	var n int
	check("guard", pool.QueryRow(ctx, "SELECT (SELECT count(*) FROM machines)+(SELECT count(*) FROM materials)+(SELECT count(*) FROM machine_jobs)").Scan(&n))
	if n > 0 {
		log.Fatal("data already exists; refusing to seed")
	}
	loc, err := time.LoadLocation("Europe/Berlin")
	check("tz", err)

	s := &seeder{ctx: ctx, pool: pool, cfg: cfg, rng: mrand.New(mrand.NewSource(42)), loc: loc, now: time.Now().UTC(),
		orgs: map[string]party{}, mats: map[string]*mat{}, prods: map[string]*product{}, machines: map[string]*mach{}, roles: map[string]uuid.UUID{}}
	s.people = people.NewService(pool)
	s.accounts = accounts.NewService(pool, cfg)
	s.ml = machinelogbook.NewService(pool)
	s.printing = printing.NewService(pool, s.ml)
	s.pc, err = printerconnectors.NewService(pool, s.printing, cfg.EncryptionKeys)
	check("pc", err)
	s.orders = orders.NewService(pool, s.ml)
	s.od, err = opendays.NewService(pool, cfg)
	check("opendays", err)

	s.setupActor()
	s.createPeople()
	s.createOrgsAndPricing()
	s.createCatalog()
	s.setupPrinters()
	s.setupConnector()
	s.planEverything()
	s.runTimeline()
	s.finishPrints()
	s.priceAdjustments()
	s.createOrders()
	s.assignOpenDays()
	s.setThresholds()
	log.Println("DONE")
}

func (s *seeder) mlAt(t time.Time) *ML {
	return machinelogbook.NewService(s.pool, machinelogbook.WithClock(func() time.Time { return t }))
}

func (s *seeder) ago(d time.Duration) time.Time { return s.now.Add(-d) }

func (s *seeder) setupActor() {
	var acc, person uuid.UUID
	var fn, ln string
	check("actor", s.pool.QueryRow(s.ctx, `SELECT a.id, p.id, p.first_name, p.last_name FROM accounts a JOIN people p ON p.id=a.person_id WHERE p.email='hauke.noel@icloud.com'`).Scan(&acc, &person, &fn, &ln))
	pr, err := authorization.LoadPermissionsFrom(s.ctx, s.pool, authorization.Principal{AccountID: acc, PersonID: person, FirstName: fn, LastName: ln, Assurance: authorization.AssuranceNormal, AuthenticatedAt: s.now})
	check("principal", err)
	if !pr.Master {
		log.Fatal("actor is not master")
	}
	s.actor = pr
	rows, err := s.pool.Query(s.ctx, "SELECT id, name FROM roles")
	check("roles", err)
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var name string
		check("scan", rows.Scan(&id, &name))
		s.roles[name] = id
	}
	s.supervisors = nil
}

var firstNames = []string{"Lukas", "Leon", "Finn", "Jonas", "Paul", "Felix", "Maximilian", "Noah", "Elias", "Tim", "Jan", "Niklas", "Moritz", "Philipp", "Sebastian", "Tobias", "David", "Simon", "Julian", "Fabian", "Anna", "Lena", "Marie", "Sophie", "Laura", "Hannah", "Julia", "Katharina", "Lisa", "Johanna", "Clara", "Emma", "Mia", "Leonie", "Franziska", "Carolin", "Sarah", "Nina", "Eva", "Jana", "Mehmet", "Emre", "Aylin", "Marta", "Piotr", "Ioana", "Luca", "Giulia", "Ravi", "Mei", "Amira", "Karim", "Tomas", "Elif", "Ben", "Henrik", "Greta", "Ole", "Merle", "Jannik"}
var lastNames = []string{"Müller", "Schmidt", "Schneider", "Fischer", "Weber", "Meyer", "Wagner", "Becker", "Schulz", "Hoffmann", "Schäfer", "Koch", "Bauer", "Richter", "Klein", "Wolf", "Schröder", "Neumann", "Schwarz", "Zimmermann", "Braun", "Krüger", "Hartmann", "Lange", "Schmitt", "Werner", "Krause", "Lehmann", "Köhler", "Herrmann", "König", "Walter", "Huber", "Kaiser", "Fuchs", "Peters", "Scholz", "Möller", "Weiß", "Jung", "Hahn", "Schubert", "Vogel", "Friedrich", "Keller", "Günther", "Frank", "Berger", "Winkler", "Roth", "Beck", "Lorenz", "Baumann", "Franke", "Albrecht", "Schuster", "Ludwig", "Böhm", "Winter", "Kraus", "Schumacher", "Krämer", "Vogt", "Stein", "Jäger", "Otto", "Sommer", "Seidel", "Brandt", "Haas", "Graf", "Ziegler", "Kuhn", "Engel", "Pohl", "Horn", "Busch", "Bergmann", "Voigt", "Sauer", "Arnold", "Pfeiffer", "Yilmaz", "Kaya", "Nowak", "Kowalski", "Rossi", "Nguyen", "Petrov", "Okafor", "Chen", "Singh", "Haddad", "Popescu"}

func translit(v string) string {
	r := strings.NewReplacer("ä", "ae", "ö", "oe", "ü", "ue", "ß", "ss", "Ä", "Ae", "Ö", "Oe", "Ü", "Ue", "ş", "s", "ğ", "g")
	return strings.ToLower(r.Replace(v))
}

func (s *seeder) createPeople() {
	type spec struct {
		cat    string
		count  int
		domain string
	}
	fi := s.rng.Perm(len(firstNames))
	li := s.rng.Perm(len(lastNames))
	idx := 0
	usedEmail := map[string]bool{"hauke.noel@icloud.com": true}
	usedName := map[string]bool{}
	mat := 3000000 + s.rng.Intn(500000)
	next := func(domain string) (string, string, string) {
		for {
			f := firstNames[fi[(idx*7)%len(fi)]]
			l := lastNames[li[(idx*11+idx/len(li))%len(li)]]
			idx++
			if usedName[f+l] {
				continue
			}
			usedName[f+l] = true
			email := translit(f) + "." + translit(l) + "@" + domain
			if usedEmail[email] {
				continue
			}
			usedEmail[email] = true
			return f, l, email
		}
	}
	create := func(domain string, matric bool, phone bool, role string, account bool) uuid.UUID {
		f, l, email := next(domain)
		in := people.CreateInput{FirstName: f, LastName: l, Email: &email}
		if phone {
			in.Phone = ptr(fmt.Sprintf("+49 17%d %07d", 1+s.rng.Intn(8), s.rng.Intn(10000000)))
		}
		if matric {
			mat += 1 + s.rng.Intn(900)
			in.MatriculationNumber = ptr(strconv.Itoa(mat))
		}
		p, err := s.people.Create(s.ctx, s.actor, in, nil)
		check("person "+email, err)
		ver := p.Version
		if account {
			_, err = s.accounts.CreateWithoutIdentity(s.ctx, s.actor, p.ID, ver, nil)
			check("account "+email, err)
		}
		if role != "" {
			p, err = s.people.ChangeRole(s.ctx, s.actor, p.ID, s.roles[role], ver, true, nil)
			check("role "+email, err)
		}
		return p.ID
	}
	for i := 0; i < 40; i++ {
		s.supervisors = append(s.supervisors, create("makerspace.example.org", false, i%5 == 0, "supervisor", true))
	}
	for i := 0; i < 4; i++ {
		s.trainees = append(s.trainees, create("makerspace.example.org", false, false, "trainee", true))
	}
	for i := 0; i < 20; i++ {
		id := create("stud.uni-example.test", i < 16, i%6 == 0, "", false)
		s.custs = append(s.custs, party{"person", id, "student", ""})
	}
	for i := 0; i < 5; i++ {
		id := create("uni-example.test", false, i%2 == 0, "", false)
		s.custs = append(s.custs, party{"person", id, "staff", ""})
	}
	for i := 0; i < 5; i++ {
		role := ""
		if i < 3 {
			role = "Visitor"
		}
		id := create("example.org", false, i%2 == 0, role, false)
		s.custs = append(s.custs, party{"person", id, "external", ""})
	}
	for i := range s.supervisors {
		s.opWeights = append(s.opWeights, 1/math.Pow(float64(i+1), 0.8))
	}
	// Noel does a few jobs too
	s.supervisors = append(s.supervisors, s.actor.PersonID)
	s.opWeights = append(s.opWeights, 0.5)
	log.Printf("people created: %d supervisors, %d trainees, %d customers", 40, 4, len(s.custs))
}

func (s *seeder) createOrgsAndPricing() {
	ml := s.ml
	mk := func(name, kind, key, cat string) {
		o, err := ml.CreateOrganization(s.ctx, s.actor, name, kind, nil)
		check("org", err)
		s.orgs[key] = party{"organization", o.ID, "org", name}
		_ = cat
	}
	mk("Lehrstuhl für Produktentwicklung", "institute", "chair", "staff")
	mk("Fachschaft Maschinenbau", "association", "fs", "student")
	mk("Startup Kleinteil GmbH", "company", "startup", "external")

	students, err := ml.CreatePricingGroup(s.ctx, s.actor, "Students", ptr("Default rates for enrolled students"), true, nil)
	check("pg", err)
	staff, err := ml.CreatePricingGroup(s.ctx, s.actor, "University staff", ptr("Employees of the university and its institutes"), false, nil)
	check("pg", err)
	ext, err := ml.CreatePricingGroup(s.ctx, s.actor, "External", ptr("Companies and private persons"), false, nil)
	check("pg", err)

	ftype, err := ml.CreateMachineType(s.ctx, s.actor, "FDM 3D printer", nil)
	check("mt", err)
	ltype, err := ml.CreateMachineType(s.ctx, s.actor, "Laser cutter", nil)
	check("mt", err)

	type rates struct{ fdm, laser, fil, ply, acr, mdf float64 }
	for _, g := range []struct {
		g *machinelogbook.PricingGroup
		r rates
		x bool
	}{{&students, rates{0.5, 6, 0.03, 12, 35, 8}, false}, {&staff, rates{1, 12, 0.04, 18, 50, 12}, false}, {&ext, rates{3, 30, 0.08, 40, 0, 28}, true}} {
		rule := func(kind string, mt *uuid.UUID, cat, unit *string, rate float64) {
			_, err := ml.CreatePricingRule(s.ctx, s.actor, g.g.ID, kind, mt, cat, unit, f2(rate), nil)
			check("rule", err)
		}
		rule("machine_runtime", &ftype.ID, nil, nil, g.r.fdm)
		rule("machine_runtime", &ltype.ID, nil, nil, g.r.laser)
		rule("material", nil, ptr("filament"), ptr("g"), g.r.fil)
		rule("material", nil, ptr("plywood"), ptr("m2"), g.r.ply)
		if !g.x { // External deliberately has no acrylic rule (incomplete pricing demo)
			rule("material", nil, ptr("acrylic"), ptr("m2"), g.r.acr)
		}
		rule("material", nil, ptr("mdf"), ptr("m2"), g.r.mdf)
	}
	assign := func(p party, g machinelogbook.PricingGroup) {
		_, err := ml.SetPartyPricingGroup(s.ctx, s.actor, p.ref(), &g.ID, 0, nil)
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
	assign(s.orgs["chair"], staff)
	assign(s.orgs["fs"], students)
	assign(s.orgs["startup"], ext)
	s.machines["_ftype"] = &mach{id: ftype.ID}
	s.machines["_ltype"] = &mach{id: ltype.ID}
	s.custs = append(s.custs, s.orgs["chair"], s.orgs["fs"], s.orgs["startup"])
}

func (s *seeder) createCatalog() {
	ml := s.ml
	fil := func(name, color string) {
		m, err := ml.CreateMaterialWithFilament(s.ctx, s.actor, name, "filament", ptr(color), "g", nil, ptr("1.75"), nil)
		check("mat", err)
		s.mats[name] = &mat{m.ID, name, "filament"}
	}
	for _, f := range [][2]string{{"PLA Black", "#1a1a1a"}, {"PLA White", "#f2f2f2"}, {"PLA Grey", "#8c8c8c"}, {"PLA Red", "#c62828"}, {"PETG Black", "#222222"}, {"PETG Clear", "#dde8ee"}, {"TPU 95A Black", "#111111"}, {"ASA White", "#fafafa"}} {
		fil(f[0], f[1])
	}
	for _, f := range [][2]string{{"Plywood 3 mm", "plywood"}, {"Plywood 4 mm", "plywood"}, {"Acrylic 3 mm clear", "acrylic"}, {"MDF 3 mm", "mdf"}} {
		m, err := ml.CreateMaterial(s.ctx, s.actor, f[0], f[1], nil, "m2", nil, nil)
		check("mat", err)
		s.mats[f[0]] = &mat{m.ID, f[0], f[1]}
	}
	prod := func(key, maker, name, matName, pack string, weight, price float64, active bool) {
		p, err := ml.CreateFilamentProduct(s.ctx, s.actor, machinelogbook.FilamentProductInput{Manufacturer: maker, Name: name, NetWeightG: f1(weight), Packaging: pack, MaterialID: s.mats[matName].id, DefaultPrice: ptr(f2(price)), Active: true}, nil)
		check("product", err)
		if !active {
			_, err = ml.UpdateFilamentProduct(s.ctx, s.actor, p.ID, machinelogbook.FilamentProductInput{Manufacturer: maker, Name: name, NetWeightG: f1(weight), Packaging: pack, MaterialID: s.mats[matName].id, DefaultPrice: ptr(f2(price)), Active: false, ExpectedVersion: p.Version}, nil)
			check("product deactivate", err)
		}
		s.prods[key] = &product{p.ID, matName, name, maker, weight, price}
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

func (s *seeder) setupPrinters() {
	ml := s.ml
	mk := func(key, name, typeKey string, fdm, bambu bool, ext *string) *mach {
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

func (s *seeder) dateOf(month time.Month, day int) time.Time {
	return time.Date(2026, month, day, 12, 0, 0, 0, s.loc).UTC()
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

func (s *seeder) nextBarcode() string {
	s.idCounter++
	return fmt.Sprintf("42%011d", 60000000000+int64(s.idCounter)*7919+int64(s.rng.Intn(1000)))
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
	sp, err := svc.CreateFilamentSpool(s.ctx, s.actor, machinelogbook.FilamentSpoolInput{Kind: "single_use", Label: label, ProductID: &p.id, MaterialID: s.mats[p.mat].id,
		InitialNetWeightG: f1(p.weight), StockMode: "new_acquisition", TotalPrice: ptr(f2(p.price * (0.97 + s.rng.Float64()*0.06))), TareWeightG: ptr("210"),
		AcquiredOn: &at, AcquisitionReference: ptr(fmt.Sprintf("RE-%d-%04d", at.Year(), 1000+s.rng.Intn(8000))), StorageLocation: ptr("Filament shelf"), OccurredAt: at, ExpectedInventoryVersion: m.InventoryVersion}, nil)
	check("single-use spool "+key, err)
	_, err = svc.AddFilamentSpoolIdentifier(s.ctx, s.actor, sp.ID, "barcode", s.nextBarcode(), nil)
	check("identifier", err)
	return sp.ID
}

func (s *seeder) newReusable(at time.Time, key, label, mode string) *reusable {
	p := s.prods[key]
	m := s.mat(p.mat)
	svc := s.mlAt(at)
	in := machinelogbook.FilamentSpoolInput{Kind: "reusable", Label: label, ProductID: &p.id, MaterialID: s.mats[p.mat].id, InitialNetWeightG: f1(p.weight),
		StockMode: mode, TareWeightG: ptr("250"), AcquiredOn: &at, StorageLocation: ptr("AMS"), OccurredAt: at, ExpectedInventoryVersion: m.InventoryVersion}
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
	_, err = s.pool.Exec(s.ctx, "UPDATE printer_spool_assignments SET mounted_at=$1 WHERE slot_id=$2 AND spool_id=$3 AND unmounted_at IS NULL", at.UTC(), sl.id, spool)
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
		return &machinelogbook.LeftoverInput{Basis: "weighed", GrossWeightG: ptr(f1(tare + math.Floor(rem))), Disposition: ptr("disposed")}
	}
	switch r := s.rng.Float64(); {
	case r < 0.4:
		return &machinelogbook.LeftoverInput{Basis: "system", Disposition: ptr("returned_to_stock")}
	case r < 0.75:
		return &machinelogbook.LeftoverInput{Basis: "weighed", GrossWeightG: ptr(f1(tare + math.Floor(rem*0.96))), Disposition: ptr("returned_to_stock")}
	default:
		if rem < 120 {
			return &machinelogbook.LeftoverInput{Basis: "weighed", GrossWeightG: ptr(f1(tare + math.Floor(rem))), Disposition: ptr("disposed")}
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
	_, err := svc.ChangeFilamentSpoolFill(s.ctx, s.actor, r.id, machinelogbook.ChangeFillInput{Leftover: lo, Fill: fill, KeepIdentifierIDs: keep, OccurredAt: at, ExpectedVersion: sp.Version}, nil)
	check(fmt.Sprintf("change fill %s %s", r.label, matName), err)
}

func (s *seeder) setupConnector() {
	c, err := s.pc.Create(s.ctx, s.actor, "Workshop printer connector", ptr("Print lab, bench 2"), nil)
	check("connector", err)
	enr, err := s.pc.IssueEnrollment(s.ctx, s.actor, c.ID, nil)
	check("enrollment", err)
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	secret := base64.RawURLEncoding.EncodeToString(b)
	_, err = s.pc.Enroll(s.ctx, enr.Secret, uuid.Must(uuid.NewV7()), secret, "devseed-1.0.0", 1)
	check("enroll", err)
	cx, err := s.pc.Authenticate(s.ctx, secret)
	check("auth", err)
	if cx == nil {
		log.Fatal("connector authentication failed")
	}
	s.connCtx = *cx
	for _, k := range []string{"x1c", "p1s"} {
		m := s.machines[k]
		a, err := s.pc.CreateAssignment(s.ctx, s.actor, c.ID, printerconnectors.AssignmentInput{MachineID: m.id, AdapterKind: "simulator", AdapterSchemaVersion: 1, Settings: json.RawMessage(`{"scenario":"idle"}`)}, nil)
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

func (s *seeder) ingest(m *mach, run uuid.UUID, ext, kind string, at time.Time, payload map[string]any, rev *int64) {
	m.seq++
	raw, _ := json.Marshal(payload)
	rc, err := s.pc.IngestEvents(s.ctx, s.connCtx, []printerconnectors.EventInput{{EventID: uuid.Must(uuid.NewV7()), AssignmentID: m.assign, RunID: &run, HistoryComplete: true,
		ConfigurationVersion: m.cfgVer, Sequence: m.seq, OccurredAt: at.UTC(), Kind: kind, ExternalPrintID: &ext, ReportRevision: rev, Payload: raw}})
	check("ingest "+kind, err)
	if rc[0].Status != "accepted" {
		reason := ""
		if rc[0].ReasonCode != nil {
			reason = *rc[0].ReasonCode
		}
		log.Fatalf("event %s not accepted: %s %s", kind, rc[0].Status, reason)
	}
}

var fdmFiles = []string{"gearbox_housing_v3", "sensor_bracket", "drone_arm_left", "rpi_enclosure", "cable_clips_x20", "thesis_prototype_a", "handle_proto", "test_coupon_petg", "replacement_knob", "lens_holder", "planetary_gear_test", "turbine_blade", "impeller_v2", "phone_stand", "name_badges", "spacer_rings", "chassis_plate", "hinge_set"}

// printRun simulates a print and returns the observed run id.
func (s *seeder) printRun(m *mach, start, end time.Time, terminal string, file string, report *float64, slotExt string) uuid.UUID {
	run := uuid.Must(uuid.NewV7())
	ext := "sim-" + run.String()[:8]
	f := file + ".gcode.3mf"
	total := end.Sub(start)
	s.ingest(m, run, ext, "operational_state", start, map[string]any{"state": "printing", "fileName": f}, nil)
	for _, pc := range []int{25, 50, 75} {
		at := start.Add(total * time.Duration(pc) / 100)
		s.ingest(m, run, ext, "progress", at, map[string]any{"state": "printing", "percent": pc, "remainingSeconds": int(end.Sub(at).Seconds()), "fileName": f}, nil)
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

// ---------- planning ----------

var fdmTitles = []string{"Gearbox housing v3", "Sensor mount bracket", "Drone frame arm", "Enclosure for Raspberry Pi", "Cable clips (x20)", "Bachelor thesis prototype", "Prototype handle", "Test coupon PETG", "Replacement knob", "Lens holder", "Planetary gear test", "Wind turbine blade", "Pump impeller v2", "Phone stand", "Name badges", "Spacer rings", "Robotics chassis plate", "Hinge set"}
var laserTitles = []string{"Acrylic nameplate", "Puzzle (plywood)", "Workshop signage", "Gasket 3 mm", "Enclosure panels", "Stencil set", "Lampshade", "Model bridge 1:50", "Engraved coasters", "Fachschaft Schild"}
var notesList = []string{"Customer will pick up tomorrow", "Second attempt after warping on first try", "Supports removed by customer", "Rush job before deadline", "Material supplied partly by customer", "Used 0.2 mm layer height", "Test fit pending"}

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
			if p.customer.cat == "org" && p.customer.name == "Fachschaft Maschinenbau" && p.title == nil && !m.fdm {
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
		{m: s.machines["pr1"], start: s.ago(25 * time.Minute), end: s.now.Add(70 * time.Minute), outcome: "unknown", customer: s.custs[3], operator: op(), title: ptr("Bracket for sensor mount"), special: "running"},
		{m: s.machines["laser"], start: s.ago(30 * time.Minute), end: s.now.Add(25 * time.Minute), outcome: "unknown", customer: s.orgs["fs"], operator: op(), title: ptr("Fachschaft Schild"), special: "running"},
		{m: s.machines["pr2"], start: s.ago(5 * time.Hour), end: s.ago(95 * time.Minute), outcome: "unknown", customer: s.custs[7], operator: op(), special: "needs_outcome"},
		{m: s.machines["laser"], start: s.ago(20 * time.Hour), end: s.ago(19*time.Hour + 10*time.Minute), outcome: "unknown", customer: s.custs[11], operator: op(), special: "needs_outcome"},
		{m: s.machines["pr1"], start: s.ago(26 * time.Hour), end: s.ago(23 * time.Hour), outcome: "unknown", customer: s.custs[1], operator: op(), special: "needs_outcome"},
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
		_, err := s.mlAt(at).FinishFilamentSpool(s.ctx, s.actor, r.id, machinelogbook.FinishSpoolInput{Leftover: *s.leftover(sp, false), OccurredAt: at, ExpectedVersion: sp.Version}, nil)
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
		_, err := s.mlAt(fa).FinishFilamentSpool(s.ctx, s.actor, sl.cur, machinelogbook.FinishSpoolInput{Leftover: *s.leftover(sp, rem < qty+1), OccurredAt: fa, ExpectedVersion: sp.Version}, nil)
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
				out = append(out, machinelogbook.UsageInput{Ownership: "external", ExternalMaterialName: ptr("Customer-supplied PLA"), Quantity: f1(q)})
				continue
			}
			if primary == nil {
				primary = sl
			}
			sp := s.spool(spoolID)
			out = append(out, machinelogbook.UsageInput{MaterialID: *sp.MaterialID, SpoolID: &spoolID, Ownership: "makerspace", Quantity: f1(qq), QuantityBasis: "actual"})
		}
		var q0 float64
		if len(out) > 0 {
			q0 = dnum(out[0].Quantity)
		}
		return out, primary, q0
	}
	// laser
	name := []string{"Plywood 3 mm", "Plywood 4 mm", "Acrylic 3 mm clear", "MDF 3 mm"}[s.pickWeighted([]float64{4, 1.5, 2.5, 2})]
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
	return []machinelogbook.UsageInput{{MaterialID: s.mats[name].id, Ownership: "makerspace", Quantity: f3(area), QuantityBasis: "actual"}}, nil, 0
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
	in := machinelogbook.JobInput{MachineID: p.m.id, Title: p.title, StartsAt: p.start, EndsAt: p.end, Customer: p.customer.ref(), OperatorPersonID: p.operator, Outcome: p.outcome, Notes: p.notes, Usages: usages}
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
		job, err = s.ml.CreateJobFromPrint(s.ctx, s.actor, run, machinelogbook.PrintJobInput{Title: p.title, Customer: p.customer.ref(), OperatorPersonID: p.operator, Notes: p.notes, Usages: usages[:min(1, len(usages))]}, nil)
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
		job, err = s.ml.LinkPrintToJob(s.ctx, s.actor, run, job.ID, job.Version, nil)
		check("link print", err)
	default:
		job, err = s.ml.CreateManualJob(s.ctx, s.actor, in, nil)
		check("manual job", err)
	}
	s.jobs = append(s.jobs, jobRec{id: job.ID, customer: p.customer, outcome: p.outcome, incomplete: job.PricingStatus != "complete", ends: p.end, machine: p.m.name, failedRun: p.outcome == "failed"})
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
	run := uuid.Must(uuid.NewV7())
	ext := "sim-" + run.String()[:8]
	f := "gearbox_housing_v4.gcode.3mf"
	start := s.ago(55 * time.Minute)
	s.ingest(m, run, ext, "operational_state", start, map[string]any{"state": "printing", "fileName": f}, nil)
	s.ingest(m, run, ext, "progress", s.ago(2*time.Minute), map[string]any{"state": "printing", "percent": 34, "remainingSeconds": 6300, "fileName": f}, nil)
}

func (s *seeder) finishPrints() {
	cid := s.connCtx.ID
	hb := func(m *mach, state string, code *string) printerconnectors.AssignmentHealth {
		return printerconnectors.AssignmentHealth{AssignmentID: m.assign, AppliedConfigurationVersion: m.cfgVer, State: state, ErrorCode: code}
	}
	c, err := s.pc.Get(s.ctx, s.actor, cid)
	check("connector get", err)
	_, err = s.pc.Heartbeat(s.ctx, s.connCtx, printerconnectors.Heartbeat{SoftwareVersion: "devseed-1.0.0", HealthState: "degraded", ProtocolVersion: 1, AppliedConfigurationRevision: c.ConfigurationRevision,
		HealthSummary: ptr("P1S reports intermittent MQTT timeouts"), Assignments: []printerconnectors.AssignmentHealth{hb(s.machines["x1c"], "connected", nil), hb(s.machines["p1s"], "degraded", ptr("mqtt_timeout"))}})
	check("heartbeat", err)
}

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
		_, err = s.mlAt(r.ends.Add(36*time.Hour)).SetJobPriceAdjustment(s.ctx, s.actor, r.id, job.Version, kind, val, reason, nil)
		check("adjust", err)
		r.used = true
	}
	apply(get(func(r jobRec) bool { return r.failedRun && r.ends.Before(s.ago(24*time.Hour)) }), "discount_percent", "100", "Print failed due to machine fault; no charge")
	apply(get(func(r jobRec) bool { return r.customer.name == "Fachschaft Maschinenbau" && r.outcome == "successful" }), "discount_percent", "50", "Student council sponsorship")
	apply(get(func(r jobRec) bool { return r.customer.cat == "student" && r.outcome == "partial_failure" }), "discount_amount", "1.00", "Goodwill after partial failure")
	apply(get(func(r jobRec) bool {
		return r.customer.cat == "student" && r.outcome == "successful" && r.machine == "Trotec Speedy 300"
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
		o, err := s.orders.Create(s.ctx, s.actor, orders.OrderDraftInput{Customer: &orders.OrderCustomer{Kind: c.kind, ID: c.id}, FulfillmentMode: mode}, nil)
		check("order create", err)
		for _, i := range idxs {
			job, err := s.ml.GetJob(s.ctx, s.actor, s.jobs[i].id)
			check("get job", err)
			o, err = s.orders.ChangeItem(s.ctx, s.actor, o.ID, uuid.Nil, orders.OrderItemInput{Kind: "machine_job", MachineJobID: job.ID, ExpectedJobVersion: job.Version, ExpectedVersion: o.Version}, "add", nil)
			check("order add item", err)
		}
		if manual {
			o, err = s.orders.ChangeItem(s.ctx, s.actor, o.ID, uuid.Nil, orders.OrderItemInput{Kind: "manual", Description: "Design consultation", Quantity: "0.5", Unit: "h", UnitPrice: "20.00", ExpectedVersion: o.Version}, "add", nil)
			check("order manual item", err)
		}
		return o
	}
	finalize := func(o orders.Order, pays []orders.PaymentInput) orders.Order {
		o, err := s.orders.Command(s.ctx, s.actor, o.ID, orders.OrderCommand{OperationKey: uuid.Must(uuid.NewV7()), ExpectedVersion: o.Version, Payments: pays}, "finalize", nil)
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
		_, err := s.orders.RecordPayment(s.ctx, s.actor, o.ID, orders.RecordOrderPayment{OperationKey: uuid.Must(uuid.NewV7()), ExpectedVersion: o.Version, Payment: orders.PaymentInput{Method: "card", Amount: "1.00", OccurredAt: s.ago(30 * time.Hour), ExternalSource: "terminal-1", ExternalReference: "TX-884213"}}, nil)
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
		_, err = s.ml.SetJobPriceAdjustment(s.ctx, s.actor, job.ID, job.Version, "multiplier", "1.5", "Rush job surcharge added after invoicing", nil)
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

func (s *seeder) assignOpenDays() {
	periods, err := s.od.ListPeriods(s.ctx, s.actor)
	check("periods", err)
	sched, err := s.od.GetSchedule(s.ctx, s.actor, periods[0].ID)
	check("schedule", err)
	n := 0
	for di, day := range sched.Items {
		if day.EndsAt.Before(s.now) || day.Status != "scheduled" {
			continue
		}
		if n >= 6 {
			break
		}
		n++
		for _, rq := range day.Requirements {
			need := rq.RequiredCount - rq.AssignedCount
			if rq.Kind == "supervisor" && n == 6 {
				need-- // leave a gap
			}
			if rq.Kind == "trainee" && n%2 == 0 {
				continue
			}
			elig, err := s.od.EligiblePeople(s.ctx, s.actor, rq.ID, "")
			check("eligible", err)
			s.rng.Shuffle(len(elig), func(i, j int) { elig[i], elig[j] = elig[j], elig[i] })
			for _, e := range elig {
				if need <= 0 {
					break
				}
				if e.PersonID == s.actor.PersonID {
					continue
				}
				if _, err := s.od.Assign(s.ctx, s.actor, day.ID, rq.ID, e.PersonID, nil); err != nil {
					continue // already on this day or ineligible
				}
				need--
			}
		}
		_ = di
	}
	log.Printf("open days staffed: %d", n)
}

func (s *seeder) setThresholds() {
	cands := []float64{250, 500, 1000, 1500}
	scands := []float64{0.25, 0.5, 1.0}
	for name := range s.mats {
		m := s.mat(name)
		q := dnum(m.Quantity)
		c := cands
		prec := 0
		if m.Unit == "m2" {
			c = scands
			prec = 2
		}
		th := c[0] / 2
		for _, v := range c {
			if v <= q*0.7 {
				th = v
			}
		}
		if name == "TPU 95A Black" {
			th = c[len(c)-1]
			for _, v := range c {
				if v >= q*1.1 {
					th = v
					break
				}
			}
		}
		var diameter *string
		if m.Unit == "g" {
			diameter = ptr("1.75")
		}
		_, err := s.ml.UpdateMaterialWithFilament(s.ctx, s.actor, m.ID, m.Version, m.Name, m.Category, m.Color, m.Unit, true, ptr(strconv.FormatFloat(th, 'f', prec, 64)), diameter, nil)
		check("threshold "+name, err)
	}
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
