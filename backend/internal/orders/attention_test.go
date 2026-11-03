package orders

import (
	"slices"
	"testing"
	"time"
)

func orderCodes(items []OrderAttention) []OrderAttentionCode {
	codes := []OrderAttentionCode{}
	for _, item := range items {
		codes = append(codes, item.Code)
	}
	return codes
}

func TestOrderAttentionFlagsOverdueChangedAndOpenInvoiceRequests(t *testing.T) {
	now := time.Date(2026, time.November, 3, 12, 0, 0, 0, time.UTC)
	old, recent := now.Add(-15*24*time.Hour), now.Add(-13*24*time.Hour)
	submitted, issued := InvoiceSubmitted, InvoiceIssued
	tests := []struct {
		name      string
		order     Order
		finalized *time.Time
		want      []OrderAttentionCode
	}{
		{"unpaid for 15 days", Order{Status: OrderFinalized, OutstandingAmount: "12.50"}, &old, []OrderAttentionCode{AttentionBalanceOverdue}},
		{"unpaid for 13 days", Order{Status: OrderFinalized, OutstandingAmount: "12.50"}, &recent, []OrderAttentionCode{}},
		{"paid long ago", Order{Status: OrderFinalized, OutstandingAmount: "0.00"}, &old, []OrderAttentionCode{}},
		{"draft", Order{Status: OrderDraft, OutstandingAmount: "12.50"}, nil, []OrderAttentionCode{}},
		{
			"changed job",
			Order{Status: OrderDraft, OutstandingAmount: "0.00", Items: []OrderItem{{SourceChanged: true}}},
			nil,
			[]OrderAttentionCode{AttentionSourceChanged},
		},
		{
			"removed changed item",
			Order{Status: OrderDraft, OutstandingAmount: "0.00", Items: []OrderItem{{SourceChanged: true, RemovedAt: &old}}},
			nil,
			[]OrderAttentionCode{},
		},
		{
			"invoice awaiting approval",
			Order{Status: OrderFinalized, OutstandingAmount: "0.00", ActiveExternalRequestState: &submitted},
			&old,
			[]OrderAttentionCode{AttentionInvoiceRequestOpen},
		},
		{
			"invoice issued",
			Order{Status: OrderFinalized, OutstandingAmount: "0.00", ActiveExternalRequestState: &issued},
			&old,
			[]OrderAttentionCode{},
		},
	}
	for _, test := range tests {
		got := orderCodes(orderAttention(test.order, test.finalized, now))
		if !slices.Equal(got, test.want) {
			t.Errorf("%s: %v, want %v", test.name, got, test.want)
		}
	}
}
