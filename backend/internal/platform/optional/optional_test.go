package optional

import "testing"

func TestTrimmed(t *testing.T) {
	blank, padded := "  ", " value "
	if Trimmed(nil) != nil || Trimmed(&blank) != nil {
		t.Fatal("nil and blank input must become nil")
	}
	if got := Trimmed(&padded); got == nil || *got != "value" || got == &padded {
		t.Fatalf("Trimmed(%q) = %v, want a new pointer to \"value\"", padded, got)
	}
}

func TestOfAndValue(t *testing.T) {
	if Value[string](nil) != "" || Value(Of("x")) != "x" || Value[int](nil) != 0 {
		t.Fatal("Value must dereference or return the zero value")
	}
}
