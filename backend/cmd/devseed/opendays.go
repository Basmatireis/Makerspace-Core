package main

import (
	"fmt"
	"log"
	"strconv"
	"time"
	_ "time/tzdata"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/opendays"
	"github.com/google/uuid"
)

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
		if (p.Status == opendays.PeriodStaffing || p.Status == opendays.PeriodPublished) &&
			!p.StartsOn.After(nextWeek) &&
			!p.EndsOn.Before(nextWeek) {
			periodID = p.ID
			break
		}
	}
	if periodID == uuid.Nil {
		end := today.AddDate(0, 0, 120)
		p, err := s.od.CreatePeriod(
			s.ctx,
			s.actor,
			fmt.Sprintf("Open Days %s – %s", today.Format("02.01."), end.Format("02.01.2006")),
			today,
			end,
			nil,
			nil,
		)
		check("create period", err)
		for _, target := range []opendays.PeriodStatus{opendays.PeriodStaffing, opendays.PeriodPublished} {
			p, err = s.od.TransitionPeriod(s.ctx, s.actor, p.ID, p.Version, target, nil)
			check("period "+string(target), err)
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
		if day.EndsAt.After(s.now) && day.Status == opendays.DayScheduled {
			upcoming++
		}
	}
	reqs := []opendays.RequirementInput{
		{Kind: opendays.RequirementSupervisor, RequiredCount: 2, EligibleRoleIDs: []uuid.UUID{s.roles["supervisor"]}},
		{Kind: opendays.RequirementTrainee, RequiredCount: 1, EligibleRoleIDs: []uuid.UUID{s.roles["trainee"]}},
	}
	for d := today.AddDate(0, 0, 1); upcoming < 6 && !d.After(sched.Period.EndsOn); d = d.AddDate(0, 0, 1) {
		if wd := d.Weekday(); (wd != time.Tuesday && wd != time.Thursday) || usedDates[d.Format(time.DateOnly)] {
			continue
		}
		start := time.Date(d.Year(), d.Month(), d.Day(), 16, 0, 0, 0, s.loc)
		sched, err = s.od.CreateOpenDay(
			s.ctx,
			s.actor,
			periodID,
			sched.Period.Version,
			opendays.ScheduleInput{StartsAt: start.UTC(), EndsAt: start.Add(3 * time.Hour).UTC(), Requirements: reqs},
			nil,
		)
		check("create open day", err)
		upcoming++
	}
	return sched
}

func (s *seeder) assignOpenDays() {
	sched := s.openDaySchedule()
	n := 0
	for di, day := range sched.Items {
		if day.EndsAt.Before(s.now) || day.Status != opendays.DayScheduled {
			continue
		}
		if n >= 6 {
			break
		}
		n++
		for _, rq := range day.Requirements {
			need := rq.RequiredCount - rq.AssignedCount
			if rq.Kind == opendays.RequirementSupervisor && n == 6 {
				need-- // leave a gap
			}
			if rq.Kind == opendays.RequirementTrainee && n%2 == 0 {
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
		if m.Kind == machinelogbook.KindFilament {
			diameter = ptr("1.75")
		}
		_, err := s.ml.UpdateMaterial(
			s.ctx,
			s.actor,
			m.ID,
			machinelogbook.MaterialInput{
				Name:            m.Name,
				MaterialTypeID:  m.MaterialTypeID,
				ColorName:       m.ColorName,
				ColorHex:        m.ColorHex,
				Variant:         m.Variant,
				Manufacturer:    m.Manufacturer,
				StorageLocation: m.StorageLocation,
				Notes:           m.Notes,
				SalePrice:       m.SalePrice,
				PackageSize:     m.PackageSize,
				Active:          true,
				LowStockThreshold: ptr(
					strconv.FormatFloat(th, 'f', prec, 64),
				),
				FilamentDiameterMM: diameter,
				ExpectedVersion:    m.Version,
			},
			nil,
		)
		check("threshold "+name, err)
	}
}
