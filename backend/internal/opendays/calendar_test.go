package opendays

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
)

func TestAustrianHolidayProviderReturnsConfiguredHolidaysAcrossYears(t *testing.T) {
	provider, err := newHolidayProvider(config.Config{
		HolidayCountry:     "AT",
		HolidaySubdivision: "AT-6",
		HolidayLanguage:    "de",
	})
	if err != nil {
		t.Fatal(err)
	}

	holidays, err := provider.Between(
		time.Date(2026, time.October, 1, 0, 0, 0, 0, time.UTC),
		time.Date(2027, time.January, 31, 0, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatal(err)
	}

	byDate := make(map[string]string, len(holidays))
	for _, holiday := range holidays {
		byDate[holiday.Date.Format("2006-01-02")] = holiday.Name
	}
	for date, name := range map[string]string{
		"2026-10-26": "Nationalfeiertag",
		"2026-11-01": "Allerheiligen",
		"2026-12-08": "Mariä Empfängnis",
		"2026-12-25": "Christtag",
		"2026-12-26": "Stefanitag",
		"2027-01-01": "Neujahr",
		"2027-01-06": "Heilige Drei Könige",
	} {
		if byDate[date] != name {
			t.Errorf("holiday on %s = %q, want %q", date, byDate[date], name)
		}
	}
}

func TestAustrianHolidayProviderRejectsUnsupportedSubdivision(t *testing.T) {
	_, err := newHolidayProvider(config.Config{
		HolidayCountry:     "AT",
		HolidaySubdivision: "AT-99",
		HolidayLanguage:    "de",
	})
	if err == nil {
		t.Fatal("expected unsupported Austrian subdivision to fail")
	}
}
