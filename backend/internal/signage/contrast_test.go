package signage

import (
	"encoding/json"
	"os"
	"testing"
)

func TestAnnouncementTextColorVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../api/testdata/signage-announcement-contrast.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct {
			Color     string  `json:"color"`
			TextColor *string `json:"textColor"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil || len(file.Cases) < 20 {
		t.Fatalf("vector file: %v (%d cases)", err, len(file.Cases))
	}
	for _, vector := range file.Cases {
		got, ok := AnnouncementTextColor(vector.Color)
		switch {
		case vector.TextColor == nil && ok:
			t.Errorf("%s: want rejected, got %s", vector.Color, got)
		case vector.TextColor != nil && (!ok || got != *vector.TextColor):
			t.Errorf("%s: want %s, got %s (ok %v)", vector.Color, *vector.TextColor, got, ok)
		}
	}
}

func TestNormalizeColor(t *testing.T) {
	for input, want := range map[string]string{"#0F62FE": "#0f62fe", "#0f62fe": "#0f62fe"} {
		if got, ok := NormalizeColor(input); !ok || got != want {
			t.Errorf("%q: got %q %v", input, got, ok)
		}
	}
	for _, input := range []string{"", "0f62fe", "#0f62f", "#0f62fe0", "#gggggg", "red", " #0f62fe", "#0f62fe\n"} {
		if got, ok := NormalizeColor(input); ok {
			t.Errorf("%q accepted as %q", input, got)
		}
	}
}
