package signage

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

type renderVectorFile struct {
	Cases []renderVector `json:"cases"`
}

type renderVector struct {
	Name     string `json:"name"`
	Template struct {
		Fields []struct {
			Key  string `json:"key"`
			Type string `json:"type"`
		} `json:"fields"`
		Title string `json:"title"`
		Body  string `json:"body"`
		Tone  string `json:"tone"`
	} `json:"template"`
	Values      map[string]string `json:"values"`
	StartsAt    time.Time         `json:"startsAt"`
	EndsAt      *time.Time        `json:"endsAt"`
	Now         time.Time         `json:"now"`
	TimeZone    string            `json:"timeZone"`
	DisplayName string            `json:"displayName"`
	Location    string            `json:"location"`
	Machines    map[string]string `json:"machines"`
	Expected    struct {
		Title string `json:"title"`
		Body  string `json:"body"`
		Tone  string `json:"tone"`
	} `json:"expected"`
}

func TestRenderAnnouncementVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../api/testdata/signage-announcement-render.json")
	if err != nil {
		t.Fatal(err)
	}
	var file renderVectorFile
	var generic map[string]json.RawMessage
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(generic["cases"], &file.Cases); err != nil || len(file.Cases) < 10 {
		t.Fatalf("vector file: %v (%d cases)", err, len(file.Cases))
	}
	for _, vector := range file.Cases {
		t.Run(vector.Name, func(t *testing.T) {
			zone, err := time.LoadLocation(vector.TimeZone)
			if err != nil {
				t.Fatal(err)
			}
			template := RenderTemplate{
				Title: vector.Template.Title,
				Body:  vector.Template.Body,
				Tone:  Tone(vector.Template.Tone),
			}
			for _, field := range vector.Template.Fields {
				template.Fields = append(template.Fields, RenderField{Key: field.Key, Type: FieldType(field.Type)})
			}
			got := RenderAnnouncement(
				template,
				vector.Values,
				RenderTiming{StartsAt: vector.StartsAt, EndsAt: vector.EndsAt},
				RenderContext{
					Now:          vector.Now,
					TimeZone:     zone,
					DisplayName:  vector.DisplayName,
					Location:     vector.Location,
					MachineNames: vector.Machines,
				},
			)
			want := Rendered{Title: vector.Expected.Title, Body: vector.Expected.Body, Tone: vector.Expected.Tone}
			if got != want {
				t.Fatalf("rendered %#v, want %#v", got, want)
			}
		})
	}
}

func TestUnknownPlaceholders(t *testing.T) {
	got := UnknownPlaceholders([]string{"room"}, "{room} {today} {zzz}", "{ends_at} {aaa} {zzz} {Today}")
	want := []string{"Today", "aaa", "zzz"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unknown placeholders = %v, want %v", got, want)
	}
	if got := UnknownPlaceholders(nil, "plain", "{display}{location}{starts_at}{ends_on}{ends}"); len(got) != 0 {
		t.Fatalf("built-ins reported unknown: %v", got)
	}
}
