package audit

import (
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

func TestListRejectsInvalidFiltersBeforeQuery(t *testing.T) {
	now := time.Now().UTC()
	later := now.Add(time.Minute)
	tests := []struct {
		name   string
		filter Filter
	}{
		{name: "reversed time range", filter: Filter{Limit: 25, OccurredFrom: &later, OccurredTo: &now}},
		{name: "oversized cursor", filter: Filter{Limit: 25, Cursor: strings.Repeat("a", 501)}},
		{name: "oversized action", filter: Filter{Limit: 25, Action: stringPointer(strings.Repeat("a", 129))}},
		{name: "oversized resource type", filter: Filter{Limit: 25, ResourceType: stringPointer(strings.Repeat("a", 65))}},
	}
	service := NewService(nil)
	principal := authorization.Principal{Master: true}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := service.List(t.Context(), principal, test.filter)
			if !apperror.IsCode(err, "invalid_request") {
				t.Fatalf("expected invalid_request, got %v", err)
			}
		})
	}
}

func stringPointer(value string) *string { return &value }
