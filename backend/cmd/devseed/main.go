// Command devseed adds demo data for a small/medium university makerspace to
// the development database: people, machines, materials, spools, jobs, prints,
// orders and open day assignments. It writes exclusively through the service
// layer so business rules and audit events apply as they would in normal use.
//
// It runs on top of existing data and can be run repeatedly. Shared catalog
// records (roles, organizations, pricing groups, machine types, material
// types, articles) are reused by name when a compatible one exists; every
// run creates its own people, machines, connector, jobs and orders, with a
// short run tag in the names that must be unique. When no master account
// exists, it bootstraps a "Devseed Admin" master without a usable password.
//
// The program refuses to run when APP_ENV is "production" or "prod".
//
// Run it against the development database with:
//
//	make seed-dev
//	make seed-dev SEED_ARGS="-seed 42 -actor-email someone@example.org"
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
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
	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/opendays"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/orders"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
func f4(v float64) string { return strconv.FormatFloat(v, 'f', 4, 64) }

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

// product describes a filament that spools are bought as. It only exists in
// the seed; the manufacturer and name become the snapshot of the fill.
type product struct {
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
	rolesSvc *roles.Service
	accounts *accounts.Service
	ml       *ML
	printing *printing.Service
	pc       *printerconnectors.Service
	orders   *orders.Service
	od       *opendays.Service
	loc      *time.Location
	now      time.Time
	tag      string        // short per-run tag for names that must be unique
	shift    time.Duration // moves the fixed stock timeline so it ends today

	roles       map[string]uuid.UUID
	supervisors []uuid.UUID
	trainees    []uuid.UUID
	custs       []party
	orgs        map[string]party
	mats        map[string]*mat
	matTypes    map[string]uuid.UUID // material types by name
	newMats     map[string]bool      // materials created by this run
	prods       map[string]*product
	machines    map[string]*mach
	reus        []*reusable
	connCtx     printerconnectors.Context
	events      []event
	jobs        []jobRec
	opWeights   []float64
	spoolSeq    int
}

// timelineAnchor is the day the fixed stock and spool timeline (dateOf) was
// written for. dateOf shifts those dates so the timeline always ends today.
var timelineAnchor = time.Date(2026, 10, 14, 0, 0, 0, 0, time.UTC)

func main() {
	seed := flag.Int64("seed", time.Now().UnixNano(), "random seed; the same seed produces the same structure")
	actorEmail := flag.String("actor-email", "", "contact email of the master person to act as (default: first master)")
	flag.Parse()
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

	tz := cfg.MakerspaceTimeZone
	if tz == "" {
		tz = "Europe/Vienna"
	}
	loc, err := time.LoadLocation(tz)
	check("tz", err)
	tagBytes := make([]byte, 2)
	_, _ = rand.Read(tagBytes)
	now := time.Now().UTC()
	anchor := time.Date(timelineAnchor.Year(), timelineAnchor.Month(), timelineAnchor.Day(), 0, 0, 0, 0, loc)
	today := now.In(loc)
	s := &seeder{ctx: ctx, pool: pool, cfg: cfg, rng: mrand.New(mrand.NewSource(*seed)), loc: loc, now: now,
		tag:   hex.EncodeToString(tagBytes),
		shift: time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, loc).Sub(anchor),
		orgs:  map[string]party{}, mats: map[string]*mat{}, matTypes: map[string]uuid.UUID{}, newMats: map[string]bool{}, prods: map[string]*product{}, machines: map[string]*mach{}, roles: map[string]uuid.UUID{}}
	log.Printf("devseed run %s (seed %d)", s.tag, *seed)
	s.people = people.NewService(pool)
	s.rolesSvc = roles.NewService(pool)
	s.accounts = accounts.NewService(pool, cfg)
	s.ml = machinelogbook.NewService(pool)
	s.printing = printing.NewService(pool)
	s.pc, err = printerconnectors.NewService(pool, s.printing, cfg.EncryptionKeys)
	check("pc", err)
	s.orders = orders.NewService(pool, s.ml)
	s.od, err = opendays.NewService(pool, cfg)
	check("opendays", err)

	s.setupActor(*actorEmail)
	s.ensureRoles()
	s.createPeople()
	s.createOrgsAndPricing()
	s.createCatalog()
	s.setupPrinters()
	s.setupConnector()
	s.planEverything()
	s.runTimeline()
	s.seedProcessJobs()
	s.finishPrints()
	s.priceAdjustments()
	s.createOrders()
	s.assignOpenDays()
	s.setThresholds()
	log.Printf("DONE (run %s)", s.tag)
}

func (s *seeder) mlAt(t time.Time) *ML {
	return machinelogbook.NewService(s.pool, machinelogbook.WithClock(func() time.Time { return t }))
}

func (s *seeder) ago(d time.Duration) time.Time { return s.now.Add(-d) }

const masterQuery = `SELECT a.id, p.id, p.first_name, p.last_name FROM accounts a
JOIN people p ON p.id = a.person_id
JOIN person_roles pr ON pr.person_id = p.id
JOIN roles r ON r.id = pr.role_id
WHERE r.system_key = 'master' AND a.status = 'enabled' AND ($1 = '' OR lower(p.email) = lower($1))
ORDER BY a.created_at, a.id LIMIT 1`

// setupActor acts as the requested master, else the oldest master. Without
// any master it bootstraps "Devseed Admin" with a random password that is
// never shown, so the account exists only to own the seeded changes.
func (s *seeder) setupActor(email string) {
	var acc, person uuid.UUID
	var fn, ln string
	err := s.pool.QueryRow(s.ctx, masterQuery, email).Scan(&acc, &person, &fn, &ln)
	if errors.Is(err, pgx.ErrNoRows) && email != "" {
		log.Fatalf("no enabled master account with contact email %q", email)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		pw := make([]byte, 32)
		_, _ = rand.Read(pw)
		_, err = admin.NewService(s.pool).BootstrapMaster(s.ctx, admin.BootstrapInput{FirstName: "Devseed", LastName: "Admin",
			ContactEmail: "devseed-admin@makerspace.example.org", LoginEmail: "devseed-admin@makerspace.example.org", Password: base64.RawURLEncoding.EncodeToString(pw)})
		check("bootstrap devseed master", err)
		log.Println("no master found; created Devseed Admin (devseed-admin@makerspace.example.org) without a usable password")
		err = s.pool.QueryRow(s.ctx, masterQuery, "").Scan(&acc, &person, &fn, &ln)
	}
	check("actor", err)
	pr, err := authorization.LoadPermissionsFrom(s.ctx, s.pool, authorization.Principal{AccountID: acc, PersonID: person, FirstName: fn, LastName: ln, Assurance: authorization.AssuranceNormal, AuthenticatedAt: s.now})
	check("principal", err)
	if !pr.Master {
		log.Fatal("actor is not master")
	}
	s.actor = pr
	log.Printf("acting as %s %s", fn, ln)
}

// ensureRoles reuses the supervisor, trainee and Visitor roles by name and
// creates the ones that are missing.
func (s *seeder) ensureRoles() {
	rows, err := s.pool.Query(s.ctx, "SELECT id, name FROM roles")
	check("roles", err)
	for rows.Next() {
		var id uuid.UUID
		var name string
		check("scan", rows.Scan(&id, &name))
		s.roles[strings.ToLower(name)] = id
	}
	rows.Close()
	check("roles", rows.Err())
	grants := func(ps ...authorization.Permission) []authorization.PermissionGrant {
		var out []authorization.PermissionGrant
		for _, p := range ps {
			out = append(out, authorization.PermissionGrant{PermissionID: p, Scope: authorization.GrantEverywhere})
		}
		return out
	}
	for _, r := range []struct {
		name, desc string
		grants     []authorization.PermissionGrant
		dashboard  bool
	}{
		{"supervisor", "Runs the workshop during open hours (created by devseed)", grants(
			authorization.SupervisorDashboardRead, authorization.OpenDaysRead, authorization.OpenDaysSignup,
			authorization.MachinesRead, authorization.MachineJobsRead, authorization.MachineJobsCreate, authorization.MachineJobsEdit,
			authorization.InventoryRead, authorization.FilamentSpoolsManage, authorization.PrinterSlotsAssign,
			authorization.OrganizationsRead, authorization.PricingRead), true},
		{"trainee", "Supervisor in training (created by devseed)", grants(
			authorization.OpenDaysRead, authorization.OpenDaysSignup, authorization.MachinesRead, authorization.MachineJobsRead, authorization.InventoryRead), false},
		{"Visitor", "External visitor without permissions (created by devseed)", nil, false},
	} {
		if _, ok := s.roles[strings.ToLower(r.name)]; ok {
			continue
		}
		role, err := s.rolesSvc.CreateWithBehaviors(s.ctx, s.actor, r.name, ptr(r.desc), r.grants, false, "not_required", r.dashboard, nil)
		check("role "+r.name, err)
		s.roles[strings.ToLower(r.name)] = role.ID
		log.Printf("created role %s", r.name)
	}
}

// existing returns the id of the row the query finds, if any.
func (s *seeder) existing(query string, args ...any) (uuid.UUID, bool) {
	var id uuid.UUID
	err := s.pool.QueryRow(s.ctx, query, args...).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, false
	}
	check("lookup", err)
	return id, true
}

// tagged marks a name with the run tag to keep it unique.
func (s *seeder) tagged(name string) string { return name + " · demo " + s.tag }

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
	// Emails need not be unique, but repeated runs read better without
	// duplicates. Matriculation numbers are unique, so continue after the
	// highest existing one.
	usedEmail := map[string]bool{}
	rows, err := s.pool.Query(s.ctx, "SELECT lower(email) FROM people WHERE email IS NOT NULL")
	check("emails", err)
	for rows.Next() {
		var e string
		check("scan", rows.Scan(&e))
		usedEmail[e] = true
	}
	rows.Close()
	check("emails", rows.Err())
	usedName := map[string]bool{}
	var maxMat int64
	check("matriculation", s.pool.QueryRow(s.ctx, "SELECT coalesce(max(matriculation_number::bigint), 0) FROM people WHERE matriculation_number ~ '^[0-9]{1,15}$'").Scan(&maxMat))
	mat := max(3000000+s.rng.Intn(500000), int(maxMat))
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
			for n := 2; usedEmail[email]; n++ {
				email = fmt.Sprintf("%s.%s%d@%s", translit(f), translit(l), n, domain)
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
			p, err = s.people.ChangeRole(s.ctx, s.actor, p.ID, s.roles[strings.ToLower(role)], ver, true, nil)
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
	// the acting master does a few jobs too
	s.supervisors = append(s.supervisors, s.actor.PersonID)
	s.opWeights = append(s.opWeights, 0.5)
	log.Printf("people created: %d supervisors, %d trainees, %d customers", 40, 4, len(s.custs))
}

// claim returns the id of a reusable row named name in table, where
// compatible ($2...) decides reusability. Otherwise it returns the name to
// create: name itself, or a tagged variant when an incompatible row holds it.
func (s *seeder) claim(table, name, compatible string, args ...any) (uuid.UUID, string) {
	if id, ok := s.existing("SELECT id FROM "+table+" WHERE lower(name) = lower($1) AND "+compatible, append([]any{name}, args...)...); ok {
		return id, ""
	}
	if _, ok := s.existing("SELECT id FROM "+table+" WHERE lower(name) = lower($1)", name); ok {
		return uuid.Nil, s.tagged(name)
	}
	return uuid.Nil, name
}

func (s *seeder) createOrgsAndPricing() {
	ml := s.ml
	newOrgs := map[string]bool{}
	mk := func(name, kind, key string) {
		id, create := s.claim("organizations", name, "active")
		if create != "" {
			o, err := ml.CreateOrganization(s.ctx, s.actor, create, kind, machinelogbook.OrganizationDetailsInput{}, nil)
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
	for _, t := range [][2]string{{"PLA", "g"}, {"PETG", "g"}, {"TPU 95A", "g"}, {"ASA", "g"}, {"Plywood", "m2"}, {"Acrylic", "m2"}, {"MDF", "m2"}} {
		if t[1] == "g" {
			s.materialType(t[0], "filament", t[1])
		} else {
			s.materialType(t[0], "consumable", t[1], "laser_cutting", "other")
		}
	}
	// Categories of parts: stock that is counted and sold but never used in a machine run.
	s.materialType("Fasteners", "part", "piece")
	s.materialType("Bike parts", "part", "piece")
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
		s.materialType(t.name, "consumable", t.unit, t.processes...)
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
			if _, taken := s.existing("SELECT id FROM pricing_rules WHERE pricing_group_id = $1 AND kind = $2 AND active AND COALESCE(machine_type_id, material_type_id) = $3 AND measure IS NOT DISTINCT FROM $4::text", g.id, kind, selector, measure); taken {
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
func (s *seeder) materialType(name, kind, unit string, processes ...string) uuid.UUID {
	if id, ok := s.matTypes[name]; ok {
		return id
	}
	id, ok := s.existing("SELECT id FROM material_types WHERE lower(name) = lower($1) AND unit = $2", name, unit)
	if !ok {
		createName := name
		if _, taken := s.existing("SELECT id FROM material_types WHERE lower(name) = lower($1)", name); taken {
			createName = s.tagged(name) // same name, other unit: keep both
		}
		t, err := s.ml.CreateMaterialType(s.ctx, s.actor, createName, kind, unit, processes, nil)
		check("material type", err)
		id = t.ID
	}
	s.matTypes[name] = id
	return id
}

// filamentArticles are the manufacturer and variant of the seeded filament.
var filamentArticles = map[string]struct{ manufacturer, variant string }{
	"PLA Black": {"Bambu Lab", "Basic"}, "PLA White": {"Bambu Lab", "Basic"}, "PLA Grey": {"Extrudr", "NX2"}, "PLA Red": {"Bambu Lab", "Basic"},
	"PETG Black": {"Prusa Research", "Prusament"}, "PETG Clear": {"Prusa Research", "Prusament"}, "TPU 95A Black": {"Extrudr", "Medium"}, "ASA White": {"Polymaker", "ASA"},
}

func (s *seeder) createCatalog() {
	ml := s.ml
	// Materials are reused when name and unit match.
	material := func(name, typeName, unit string, colorName, colorHex *string) {
		typeID := s.matTypes[typeName]
		id, create := s.claim("materials", name, "active AND unit = $2", unit)
		if create != "" {
			in := machinelogbook.MaterialInput{Name: create, MaterialTypeID: typeID, ColorName: colorName, ColorHex: colorHex}
			if unit == "g" {
				in.FilamentDiameterMM = ptr("1.75")
				in.PackageSize = ptr("1000")
				if f, ok := filamentArticles[name]; ok {
					in.Manufacturer, in.Variant = ptr(f.manufacturer), ptr(f.variant)
				}
			}
			m, err := ml.CreateMaterial(s.ctx, s.actor, in, nil)
			check("mat", err)
			id = m.ID
			s.newMats[name] = true
		}
		s.mats[name] = &mat{id, name, typeName}
	}
	for _, f := range []struct{ name, typeName, colorName, hex string }{
		{"PLA Black", "PLA", "Black", "#1A1A1A"}, {"PLA White", "PLA", "White", "#F2F2F2"}, {"PLA Grey", "PLA", "Grey", "#8C8C8C"}, {"PLA Red", "PLA", "Red", "#C62828"},
		{"PETG Black", "PETG", "Black", "#222222"}, {"PETG Clear", "PETG", "Clear", "#DDE8EE"}, {"TPU 95A Black", "TPU 95A", "Black", "#111111"}, {"ASA White", "ASA", "White", "#FAFAFA"},
	} {
		material(f.name, f.typeName, "g", ptr(f.colorName), ptr(f.hex))
	}
	for _, f := range [][2]string{{"Plywood 3 mm", "Plywood"}, {"Plywood 4 mm", "Plywood"}, {"Acrylic 3 mm clear", "Acrylic"}, {"MDF 3 mm", "MDF"}} {
		material(f[0], f[1], "m2", nil, nil)
	}
	// Materials of the other processes. They stay out of newMats: the generic
	// stock thresholds are sized for grams and square metres.
	extra := func(name, typeName, unit string, colorName, colorHex *string) {
		typeID := s.matTypes[typeName]
		id, create := s.claim("materials", name, "active AND unit = $2", unit)
		if create != "" {
			m, err := ml.CreateMaterial(s.ctx, s.actor, machinelogbook.MaterialInput{Name: create, MaterialTypeID: typeID, ColorName: colorName, ColorHex: colorHex, LowStockThreshold: nil}, nil)
			check("mat", err)
			id = m.ID
		}
		s.mats[name] = &mat{id, name, typeName}
	}
	for _, ink := range []struct{ name, color, hex string }{
		{"UV ink Cyan", "Cyan", "#00AEEF"}, {"UV ink Magenta", "Magenta", "#EC008C"}, {"UV ink Yellow", "Yellow", "#FFF200"},
		{"UV ink Black", "Black", "#1A1A1A"}, {"UV ink White", "White", "#F5F5F5"},
	} {
		extra(ink.name, "UV ink", "ml", ptr(ink.color), ptr(ink.hex))
	}
	extra("DTF sticker paper A4", "DTF sticker paper", "cm2", nil, nil)
	extra("Roll-to-film 30 cm", "Roll-to-film", "m", nil, nil)
	extra("Tear-away stabilizer", "Stabilizer (tear-away)", "m", nil, nil)
	extra("Birch plywood 4 mm sheet", "Birch plywood", "cm2", nil, nil)
	extra("Vinyl foil matt white", "Vinyl foil", "cm2", nil, nil)

	// Parts: stock that is counted and sold. Each article is received with its first purchase.
	part := func(name, typeName, manufacturer, location string, packageSize, salePrice string, packageCount int, totalPrice, supplier string) {
		_, create := s.claim("materials", name, "active AND unit = $2", "piece")
		if create == "" {
			return
		}
		_, err := ml.ReceiveStock(s.ctx, s.actor, machinelogbook.ReceiptInput{
			Material:     &machinelogbook.MaterialInput{Name: create, MaterialTypeID: s.matTypes[typeName], Manufacturer: &manufacturer, StorageLocation: &location, SalePrice: &salePrice, PackageSize: &packageSize},
			PackageCount: packageCount, TotalPrice: totalPrice, Supplier: &supplier, Reference: ptr(fmt.Sprintf("PO-%d-%03d", s.dateOf(9, 20).Year(), 100+s.rng.Intn(800))), OccurredAt: s.dateOf(9, 20)}, nil)
		check("part "+name, err)
	}
	part("M3 heat-set insert", "Fasteners", "Ruthex", "Shelf B2", "100", "0.15", 5, "62.50", "Fasteners Online")
	part("M3x8 screw", "Fasteners", "Würth", "Shelf B2", "200", "0.05", 4, "28.00", "Fasteners Online")
	part("Bike chain 8-speed", "Bike parts", "KMC", "Bike corner", "1", "14.90", 6, "42.00", "Radsport Huber")
	part("Brake caliper", "Bike parts", "Shimano", "Bike corner", "1", "39.00", 4, "96.00", "Radsport Huber")

	// Filament the spools are bought as. Only the manufacturer and the name end up in the data: the fill snapshots them.
	prod := func(key, maker, name, matName string, weight, price float64) {
		s.prods[key] = &product{matName, name, maker, weight, price}
	}
	prod("bl-black", "Bambu Lab", "PLA Basic Black (refill)", "PLA Black", 1000, 17.49)
	prod("bl-white", "Bambu Lab", "PLA Basic White (refill)", "PLA White", 1000, 17.49)
	prod("bl-grey", "Bambu Lab", "PLA Basic Grey (refill)", "PLA Grey", 1000, 17.49)
	prod("bl-red", "Bambu Lab", "PLA Basic Red (refill)", "PLA Red", 1000, 17.49)
	prod("bl-petg", "Bambu Lab", "PETG HF Black (refill)", "PETG Black", 1000, 19.99)
	prod("bl-charcoal", "Bambu Lab", "PLA Matte Charcoal (refill)", "PLA Black", 1000, 21.99)
	prod("pr-pla", "Prusa Research", "Prusament PLA Prusa Galaxy Black", "PLA Black", 1000, 29.99)
	prod("pr-petg-black", "Prusa Research", "Prusament PETG Jet Black", "PETG Black", 1000, 29.99)
	prod("pr-petg-clear", "Prusa Research", "Prusament PETG Clear", "PETG Clear", 1000, 29.99)
	prod("ex-grey", "Extrudr", "PLA NX2 Grey", "PLA Grey", 1000, 26.50)
	prod("ex-tpu", "Extrudr", "TPU Medium Black", "TPU 95A Black", 500, 27.90)
	prod("pm-asa", "Polymaker", "ASA White", "ASA White", 1000, 24.99)
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

func (s *seeder) newSingleUse(at time.Time, key, label string) uuid.UUID {
	p := s.prods[key]
	m := s.mat(p.mat)
	svc := s.mlAt(at)
	sp, err := svc.CreateFilamentSpool(s.ctx, s.actor, machinelogbook.FilamentSpoolInput{Kind: "single_use", Label: label, Manufacturer: &p.maker, ProductName: &p.name, MaterialID: s.mats[p.mat].id,
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
	in := machinelogbook.FilamentSpoolInput{Kind: "reusable", Label: label, Manufacturer: &p.maker, ProductName: &p.name, MaterialID: s.mats[p.mat].id, InitialNetWeightG: f1(p.weight),
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
			fill.Manufacturer, fill.ProductName = &p.maker, &p.name
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
	c, err := s.pc.Create(s.ctx, s.actor, s.freeName("printer_connectors", "Workshop printer connector"), ptr("Print lab, bench 2"), nil)
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
		job, err = s.ml.CreateJobFromRun(s.ctx, s.actor, run, machinelogbook.RunJobInput{Title: p.title, Customer: p.customer.ref(), OperatorPersonID: p.operator, Notes: p.notes}, nil)
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
	s.jobs = append(s.jobs, jobRec{id: job.ID, customer: p.customer, outcome: p.outcome, incomplete: job.PricingStatus != "complete", ends: p.end, machine: p.m.name, failedRun: p.outcome == "failed"})
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
		"Tear-away stabilizer": {50, 20}, "UV ink Cyan": {200, 90}, "UV ink Magenta": {200, 90}, "UV ink Yellow": {200, 90},
		"UV ink Black": {200, 90}, "UV ink White": {300, 140}, "DTF sticker paper A4": {20000, 60}, "Roll-to-film 30 cm": {30, 75},
		"Birch plywood 4 mm sheet": {40000, 45}, "Vinyl foil matt white": {30000, 35},
	}
	bought := map[string]bool{}
	jobs := []job{
		{"embroidery", "Fachschaft polo logo", s.orgs["fs"], 9, 38, machinelogbook.RunMeasures{"stitches": 12400}, []use{{"Tear-away stabilizer", "0.4"}}},
		{"embroidery", "Workshop patches", s.custs[2], 4, 72, machinelogbook.RunMeasures{"stitches": 31250}, []use{{"Tear-away stabilizer", "0.9"}}},
		{"uv", "Phone case batch", s.custs[4], 7, 55, nil, []use{{"UV ink Cyan", "0.45"}, {"UV ink Magenta", "0.62"}, {"UV ink Yellow", "0.38"}, {"UV ink Black", "1.20"}, {"UV ink White", "1.85"}, {"DTF sticker paper A4", "180"}}},
		{"uv", "Sticker sheets", s.orgs["startup"], 2, 41, nil, []use{{"UV ink Cyan", "0.20"}, {"UV ink Black", "0.75"}, {"UV ink White", "0.90"}, {"DTF sticker paper A4", "420"}, {"Roll-to-film 30 cm", "0.5"}}},
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
			usages = append(usages, machinelogbook.UsageInput{MaterialID: s.mats[u.name].id, Ownership: "makerspace", Quantity: u.qty, QuantityBasis: "actual"})
		}
		job, err := s.ml.CreateManualJob(s.ctx, s.actor, machinelogbook.JobInput{MachineID: m.id, Title: ptr(j.title), StartsAt: start, EndsAt: end, Customer: j.customer.ref(), OperatorPersonID: op, Outcome: "successful", Usages: usages, Measures: j.measures}, nil)
		check("process job "+j.title, err)
		s.jobs = append(s.jobs, jobRec{id: job.ID, customer: j.customer, outcome: "successful", incomplete: job.PricingStatus != "complete", ends: end, machine: m.name})
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
	apply(get(func(r jobRec) bool { return r.customer.id == s.orgs["fs"].id && r.outcome == "successful" }), "discount_percent", "50", "Student council sponsorship")
	apply(get(func(r jobRec) bool { return r.customer.cat == "student" && r.outcome == "partial_failure" }), "discount_amount", "1.00", "Goodwill after partial failure")
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
		_, err := s.orders.RecordPayment(s.ctx, s.actor, o.ID, orders.RecordOrderPayment{OperationKey: uuid.Must(uuid.NewV7()), ExpectedVersion: o.Version, Payment: orders.PaymentInput{Method: "card", Amount: "1.00", OccurredAt: s.ago(30 * time.Hour), ExternalSource: "terminal-1", ExternalReference: "TX-" + s.randHex(6)}}, nil)
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

// openDaySchedule returns a staffing or published period that covers the
// coming week, creating and publishing one when none exists, and tops it up
// to six upcoming open days on Tuesday and Thursday afternoons.
func (s *seeder) openDaySchedule() opendays.Schedule {
	local := s.now.In(s.loc)
	today := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
	nextWeek := today.AddDate(0, 0, 7)
	periods, err := s.od.ListPeriods(s.ctx, s.actor)
	check("periods", err)
	var periodID uuid.UUID
	for _, p := range periods {
		if (p.Status == "staffing" || p.Status == "published") && !p.StartsOn.After(nextWeek) && !p.EndsOn.Before(nextWeek) {
			periodID = p.ID
			break
		}
	}
	if periodID == uuid.Nil {
		end := today.AddDate(0, 0, 120)
		p, err := s.od.CreatePeriod(s.ctx, s.actor, fmt.Sprintf("Open Days %s – %s", today.Format("02.01."), end.Format("02.01.2006")), today, end, nil)
		check("create period", err)
		for _, target := range []string{"staffing", "published"} {
			p, err = s.od.TransitionPeriod(s.ctx, s.actor, p.ID, p.Version, target, nil)
			check("period "+target, err)
		}
		periodID = p.ID
		log.Printf("created open day period %q", p.Name)
	}
	sched, err := s.od.GetSchedule(s.ctx, s.actor, periodID)
	check("schedule", err)
	upcoming := 0
	usedDates := map[string]bool{}
	for _, day := range sched.Items {
		usedDates[day.StartsAt.In(s.loc).Format(time.DateOnly)] = true
		if day.EndsAt.After(s.now) && day.Status == "scheduled" {
			upcoming++
		}
	}
	reqs := []opendays.RequirementInput{
		{Kind: "supervisor", RequiredCount: 2, EligibleRoleIDs: []uuid.UUID{s.roles["supervisor"]}},
		{Kind: "trainee", RequiredCount: 1, EligibleRoleIDs: []uuid.UUID{s.roles["trainee"]}},
	}
	for d := today.AddDate(0, 0, 1); upcoming < 6 && !d.After(sched.Period.EndsOn); d = d.AddDate(0, 0, 1) {
		if wd := d.Weekday(); (wd != time.Tuesday && wd != time.Thursday) || usedDates[d.Format(time.DateOnly)] {
			continue
		}
		start := time.Date(d.Year(), d.Month(), d.Day(), 16, 0, 0, 0, s.loc)
		sched, err = s.od.CreateOpenDay(s.ctx, s.actor, periodID, sched.Period.Version, opendays.ScheduleInput{StartsAt: start.UTC(), EndsAt: start.Add(3 * time.Hour).UTC(), Requirements: reqs}, nil)
		check("create open day", err)
		upcoming++
	}
	return sched
}

func (s *seeder) assignOpenDays() {
	sched := s.openDaySchedule()
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
	for name := range s.newMats { // reused materials keep their thresholds
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
		if m.Kind == "filament" {
			diameter = ptr("1.75")
		}
		_, err := s.ml.UpdateMaterial(s.ctx, s.actor, m.ID, machinelogbook.MaterialInput{Name: m.Name, MaterialTypeID: m.MaterialTypeID, ColorName: m.ColorName, ColorHex: m.ColorHex, Active: true,
			Variant: m.Variant, Manufacturer: m.Manufacturer, StorageLocation: m.StorageLocation, Notes: m.Notes, SalePrice: m.SalePrice, PackageSize: m.PackageSize,
			LowStockThreshold: ptr(strconv.FormatFloat(th, 'f', prec, 64)), FilamentDiameterMM: diameter, ExpectedVersion: m.Version}, nil)
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
