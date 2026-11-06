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
// coming week, creating and publishing one when none exists. It gives the
// period a weekly Tuesday series with two timeslots and tops it up to three
// single Thursdays with three timeslots each.
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
	reqs := []opendays.RequirementInput{
		{Kind: opendays.RequirementSupervisor, RequiredCount: 2},
		{Kind: opendays.RequirementTrainee, RequiredCount: 1},
	}
	// One weekly series with two timeslots on Tuesdays, created once per period.
	series, err := s.od.ListSeries(s.ctx, s.actor, periodID)
	check("series", err)
	if len(series) == 0 && today.AddDate(0, 0, 1).Before(sched.Period.EndsOn) {
		sched, err = s.od.SaveSchedule(s.ctx, s.actor, periodID, opendays.ScheduleDelta{
			ExpectedPeriodVersion: sched.Period.Version,
			SeriesCreates: []opendays.SeriesCreate{{
				Weekday:   2,
				FromDate:  today.AddDate(0, 0, 1),
				UntilDate: sched.Period.EndsOn,
				SeriesTemplate: opendays.SeriesTemplate{
					Timeslots:        []opendays.ClockRange{{Start: "16:00", End: "18:00"}, {Start: "18:00", End: "20:00"}},
					SupervisorPlaces: 2,
					TraineePlaces:    1,
				},
			}},
		}, nil)
		check("create series", err)
		log.Printf("created a Tuesday open-day series")
	}
	upcoming := 0
	usedDates := map[string]bool{}
	for _, day := range sched.Items {
		usedDates[day.StartsAt.In(s.loc).Format(time.DateOnly)] = true
		if day.EndsAt.After(s.now) && day.Status == opendays.DayScheduled && day.SeriesID == nil {
			upcoming++
		}
	}
	// Up to three single Thursdays with three timeslots each.
	for d := today.AddDate(0, 0, 1); upcoming < 3 && !d.After(sched.Period.EndsOn); d = d.AddDate(0, 0, 1) {
		if d.Weekday() != time.Thursday || usedDates[d.Format(time.DateOnly)] {
			continue
		}
		slots := make([]opendays.TimeslotInput, 0, 3)
		for _, hour := range []int{14, 16, 18} {
			start := time.Date(d.Year(), d.Month(), d.Day(), hour, 0, 0, 0, s.loc)
			slots = append(slots, opendays.TimeslotInput{
				StartsAt: start.UTC(), EndsAt: start.Add(2 * time.Hour).UTC(), Requirements: reqs,
			})
		}
		sched, err = s.od.CreateOpenDay(
			s.ctx,
			s.actor,
			periodID,
			sched.Period.Version,
			opendays.ScheduleInput{Timeslots: slots},
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
		if n >= 8 {
			break
		}
		n++
		for _, rq := range day.Requirements {
			need := rq.RequiredCount - rq.AssignedCount
			if rq.Kind == opendays.RequirementSupervisor && n == 8 {
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
					continue // already in this timeslot or ineligible
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
