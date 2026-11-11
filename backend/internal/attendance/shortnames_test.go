package attendance

import (
	"reflect"
	"testing"
)

func TestShortNames(t *testing.T) {
	for _, test := range []struct {
		name  string
		names []PersonName
		want  []string
	}{
		{
			name:  "different first names keep one letter",
			names: []PersonName{{"Max", "Muster"}, {"Anna", "Muster"}},
			want:  []string{"Max M.", "Anna M."},
		},
		{
			name:  "same first name and initial show letters until they differ, ignoring case",
			names: []PersonName{{"max", "mustermann"}, {"Max", "Müller"}, {"Max", "Berger"}},
			want:  []string{"max mu.", "Max Mü.", "Max B."},
		},
		{
			name:  "a last name that is the start of another is shown in full",
			names: []PersonName{{"Lena", "Haas"}, {"Lena", "Haase"}},
			want:  []string{"Lena Haas", "Lena Haase"},
		},
		{
			name:  "identical names are numbered",
			names: []PersonName{{"Max", "Muster"}, {"max", "muster"}},
			want:  []string{"Max Muster", "max muster (2)"},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := ShortNames(test.names); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("ShortNames() = %q, want %q", got, test.want)
			}
		})
	}
}
