package surveys

import "testing"

func TestCSVSafePrefixesFormulaTriggers(t *testing.T) {
	cases := map[string]string{
		"=1+1":            "'=1+1",
		"+49 123":         "'+49 123",
		"-2":              "'-2",
		"@SUM(A1)":        "'@SUM(A1)",
		"\t=cmd":          "'\t=cmd",
		"\r=cmd":          "'\r=cmd",
		"plain":           "plain",
		"a=b":             "a=b",
		"":                "",
		"'already quoted": "'already quoted",
		"Ünïcode":         "Ünïcode",
	}
	for input, want := range cases {
		if got := csvSafe(input); got != want {
			t.Errorf("csvSafe(%q) = %q, want %q", input, got, want)
		}
	}
}
