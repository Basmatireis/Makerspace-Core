// Command devseed adds demo data for a small/medium university makerspace to
// the development database: people, machines, materials, spools, jobs, prints,
// orders and open day assignments. It writes exclusively through the service
// layer so business rules and audit events apply as they would in normal use.
//
// It runs on top of existing data and can be run repeatedly. Shared catalog
// records (roles, organizations, pricing groups, machine types, materials,
// filament products) are reused by name when a compatible one exists; every
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
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	mrand "math/rand"
	"os"
	"strconv"
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
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
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
	return machinelogbook.PartyReference{Kind: machinelogbook.PartyKind(p.kind), ID: p.id}
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
	id     uuid.UUID
	name   string
	fdm    bool
	bambu  bool
	slots  []*slot
	assign uuid.UUID
	cfgVer int64
	seq    int64
	busy   [][2]time.Time
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
		tag:      hex.EncodeToString(tagBytes),
		shift:    time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, loc).Sub(anchor),
		orgs:     map[string]party{},
		mats:     map[string]*mat{},
		matTypes: map[string]uuid.UUID{},
		newMats:  map[string]bool{},
		prods:    map[string]*product{},
		machines: map[string]*mach{},
		roles:    map[string]uuid.UUID{}}
	log.Printf("devseed run %s (seed %d)", s.tag, *seed)
	s.people = people.NewService(pool, nil)
	s.rolesSvc = roles.NewService(pool)
	s.accounts = accounts.NewService(pool, cfg, nil)
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

// ---------- planning ----------
