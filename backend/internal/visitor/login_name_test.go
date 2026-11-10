package visitor

import "testing"

func TestBaseLoginName(t *testing.T) {
	for _, tc := range []struct{ first, last, want string }{
		{"Anna-Lena", "Müller", "anna-lena.mueller"},
		{"José", "Núñez", "jose.nunez"},
		{" Jonas ", "Weiß", "jonas.weiss"},
		{"Mary Ann", "O'Brien", "maryann.obrien"},
		{"-Eve-", "Ö", "eve.oe"},
		{"李", "王", ""},
		{"Li", "王", "li"},
	} {
		if got := BaseLoginName(tc.first, tc.last); got != tc.want {
			t.Errorf("BaseLoginName(%q, %q) = %q, want %q", tc.first, tc.last, got, tc.want)
		}
	}
}
