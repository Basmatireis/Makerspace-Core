package main

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"math"
	"strconv"
	"strings"
	_ "time/tzdata"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// setupActor acts as the requested master, else the oldest master. Without
// any master it bootstraps "Devseed Admin" with a random password that is
// never shown, so the account exists only to own the seeded changes.
func (s *seeder) setupActor(email string) {
	var acc, person uuid.UUID
	var fn, ln string
	err := s.pool.QueryRow(s.ctx, masterQuery, email).Scan(&acc, &person, &fn, &ln)
	if errors.Is(err, pgx.ErrNoRows) && email != "" {
		log.Fatalf("no enabled master account with email %q", email)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		pw := make([]byte, 32)
		_, _ = rand.Read(pw)
		_, err = admin.NewService(s.pool).
			BootstrapMaster(s.ctx, admin.BootstrapInput{FirstName: "Devseed", LastName: "Admin",
				LoginEmail: "devseed-admin@makerspace.example.org",
				Password:   base64.RawURLEncoding.EncodeToString(pw)})
		check("bootstrap devseed master", err)
		log.Println(
			"no master found; created Devseed Admin (devseed-admin@makerspace.example.org) without a usable password",
		)
		err = s.pool.QueryRow(s.ctx, masterQuery, "").Scan(&acc, &person, &fn, &ln)
	}
	check("actor", err)
	pr, err := authorization.LoadPermissionsFrom(
		s.ctx,
		s.pool,
		authorization.Principal{
			AccountID:       acc,
			PersonID:        person,
			FirstName:       fn,
			LastName:        ln,
			Assurance:       authorization.AssuranceStrongMFA,
			AuthenticatedAt: s.now,
		},
	)
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
		level      *roles.StaffingLevel
	}{
		{"supervisor", "Runs the workshop during open hours (created by devseed)", grants(
			authorization.SupervisorDashboardRead, authorization.OpenDaysRead, authorization.OpenDaysSignup,
			authorization.EventsRead, authorization.EventsSignup, authorization.EventsReadAssignments,
			authorization.MachinesRead,
			authorization.MachineJobsRead,
			authorization.MachineJobsCreate,
			authorization.MachineJobsEdit,
			authorization.InventoryRead, authorization.FilamentSpoolsManage, authorization.PrinterSlotsAssign,
			authorization.OrganizationsRead, authorization.PricingRead), ptr(roles.StaffingSupervisor)},
		{"trainee", "Supervisor in training (created by devseed)", grants(
			authorization.OpenDaysRead,
			authorization.OpenDaysSignup,
			authorization.EventsRead,
			authorization.EventsSignup,
			authorization.MachinesRead,
			authorization.MachineJobsRead,
			authorization.InventoryRead), ptr(roles.StaffingTrainee)},
		{"Visitor", "External visitor without permissions (created by devseed)", nil, nil},
	} {
		if _, ok := s.roles[strings.ToLower(r.name)]; ok {
			continue
		}
		role, err := s.rolesSvc.CreateWithBehaviors(
			s.ctx,
			s.actor,
			r.name,
			ptr(r.desc),
			r.grants,
			false,
			laborordnung.ModeNotRequired,
			r.level,
			nil,
			nil,
		)
		check("role "+r.name, err)
		s.roles[strings.ToLower(r.name)] = role.ID
		log.Printf("created role %s", r.name)
	}
	// Promotions need a configured supervisor role; keep an existing choice.
	if id, ok := s.roles["supervisor"]; ok {
		_, err := s.pool.Exec(
			s.ctx,
			"UPDATE open_day_requirements SET supervisor_role_id = $1 WHERE supervisor_role_id IS NULL",
			id,
		)
		check("promotion role", err)
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

var firstNames = []string{
	"Lukas",
	"Leon",
	"Finn",
	"Jonas",
	"Paul",
	"Felix",
	"Maximilian",
	"Noah",
	"Elias",
	"Tim",
	"Jan",
	"Niklas",
	"Moritz",
	"Philipp",
	"Sebastian",
	"Tobias",
	"David",
	"Simon",
	"Julian",
	"Fabian",
	"Anna",
	"Lena",
	"Marie",
	"Sophie",
	"Laura",
	"Hannah",
	"Julia",
	"Katharina",
	"Lisa",
	"Johanna",
	"Clara",
	"Emma",
	"Mia",
	"Leonie",
	"Franziska",
	"Carolin",
	"Sarah",
	"Nina",
	"Eva",
	"Jana",
	"Mehmet",
	"Emre",
	"Aylin",
	"Marta",
	"Piotr",
	"Ioana",
	"Luca",
	"Giulia",
	"Ravi",
	"Mei",
	"Amira",
	"Karim",
	"Tomas",
	"Elif",
	"Ben",
	"Henrik",
	"Greta",
	"Ole",
	"Merle",
	"Jannik",
}

var lastNames = []string{
	"Müller",
	"Schmidt",
	"Schneider",
	"Fischer",
	"Weber",
	"Meyer",
	"Wagner",
	"Becker",
	"Schulz",
	"Hoffmann",
	"Schäfer",
	"Koch",
	"Bauer",
	"Richter",
	"Klein",
	"Wolf",
	"Schröder",
	"Neumann",
	"Schwarz",
	"Zimmermann",
	"Braun",
	"Krüger",
	"Hartmann",
	"Lange",
	"Schmitt",
	"Werner",
	"Krause",
	"Lehmann",
	"Köhler",
	"Herrmann",
	"König",
	"Walter",
	"Huber",
	"Kaiser",
	"Fuchs",
	"Peters",
	"Scholz",
	"Möller",
	"Weiß",
	"Jung",
	"Hahn",
	"Schubert",
	"Vogel",
	"Friedrich",
	"Keller",
	"Günther",
	"Frank",
	"Berger",
	"Winkler",
	"Roth",
	"Beck",
	"Lorenz",
	"Baumann",
	"Franke",
	"Albrecht",
	"Schuster",
	"Ludwig",
	"Böhm",
	"Winter",
	"Kraus",
	"Schumacher",
	"Krämer",
	"Vogt",
	"Stein",
	"Jäger",
	"Otto",
	"Sommer",
	"Seidel",
	"Brandt",
	"Haas",
	"Graf",
	"Ziegler",
	"Kuhn",
	"Engel",
	"Pohl",
	"Horn",
	"Busch",
	"Bergmann",
	"Voigt",
	"Sauer",
	"Arnold",
	"Pfeiffer",
	"Yilmaz",
	"Kaya",
	"Nowak",
	"Kowalski",
	"Rossi",
	"Nguyen",
	"Petrov",
	"Okafor",
	"Chen",
	"Singh",
	"Haddad",
	"Popescu",
}

func translit(v string) string {
	r := strings.NewReplacer(
		"ä",
		"ae",
		"ö",
		"oe",
		"ü",
		"ue",
		"ß",
		"ss",
		"Ä",
		"Ae",
		"Ö",
		"Oe",
		"Ü",
		"Ue",
		"ş",
		"s",
		"ğ",
		"g",
	)
	return strings.ToLower(r.Replace(v))
}

func (s *seeder) createPeople() {
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
	check(
		"matriculation",
		s.pool.QueryRow(
			s.ctx,
			"SELECT coalesce(max(matriculation_number::bigint), 0) FROM people WHERE matriculation_number ~ '^[0-9]{1,15}$'",
		).
			Scan(&maxMat),
	)
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
			_, err = s.accounts.Create(s.ctx, s.actor, p.ID, email, ver, nil)
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
	if id, ok := s.existing(
		"SELECT id FROM "+table+" WHERE lower(name) = lower($1) AND "+compatible,
		append([]any{name}, args...)...,
	); ok {
		return id, ""
	}
	if _, ok := s.existing("SELECT id FROM "+table+" WHERE lower(name) = lower($1)", name); ok {
		return uuid.Nil, s.tagged(name)
	}
	return uuid.Nil, name
}
