package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups"
	"github.com/google/uuid"
)

// An outsider's summary carries no to-do count at all: the field is absent from the JSON, not null or zero.
func TestWorkingGroupSummaryDTOOmitsOpenTodoCountForOutsiders(t *testing.T) {
	outsider := workinggroups.Summary{ID: uuid.New(), Name: "Laser", OpenTicketCount: 2}
	raw, err := json.Marshal(workingGroupSummaryDTO(outsider))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "openTodoCount") || !strings.Contains(string(raw), `"openTicketCount":2`) {
		t.Fatalf("outsider summary = %s", raw)
	}
	todos := int64(3)
	member := workinggroups.Summary{ID: uuid.New(), Name: "Laser", OpenTodoCount: &todos}
	raw, err = json.Marshal(workingGroupSummaryDTO(member))
	if err != nil || !strings.Contains(string(raw), `"openTodoCount":3`) {
		t.Fatalf("member summary = %s, %v", raw, err)
	}
}
