package printartifacts

import "testing"

func TestNameMismatchComparesFileAndProjectName(t *testing.T) {
	t.Parallel()
	name := func(value string) *string { return &value }
	tests := []struct {
		name       string
		printName  *string
		file, proj string
		mismatch   bool
	}{
		{"file name equals print name", name("Benchy"), "benchy.gcode.3mf", "", false},
		{"case and extension are ignored", name("BENCHY.3mf"), "benchy.3mf", "", false},
		{"project name equals print name", name("Benchy"), "export (3).3mf", "Benchy", false},
		{"different names", name("Benchy"), "Vase.3mf", "Vase", true},
		{"truncated name is a prefix match", name("A very long part na..."), "A very long part name final.gcode.3mf", "", false},
		{"truncated name prefix on project", name("A very long part na..."), "x.3mf", "A very long part name", false},
		{"truncated name with other prefix", name("A very long part na..."), "Other.3mf", "Other", true},
		{"no print name has nothing to compare", nil, "anything.3mf", "x", false},
		{"blank print name has nothing to compare", name("  "), "anything.3mf", "x", false},
		{"empty candidates mismatch", name("Benchy"), "", "", true},
		{"prefix is not an exact match", name("Benchy"), "Benchy 2.3mf", "", true},
	}
	for _, test := range tests {
		if got := NameMismatch(test.printName, test.file, test.proj); got != test.mismatch {
			t.Errorf("%s: NameMismatch = %v, want %v", test.name, got, test.mismatch)
		}
	}
}
