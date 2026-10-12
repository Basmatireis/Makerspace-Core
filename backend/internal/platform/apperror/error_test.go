package apperror

import "testing"

func TestBlockedSingleReasonKeepsStatusAndCode(t *testing.T) {
	reason := New(409, "last_master_required", "keep one master")
	err := Blocked("deletion_blocked", "blocked", reason)
	if err.HTTPStatus != 409 || err.Code != "last_master_required" || err.Message != "keep one master" {
		t.Fatalf("unexpected error %+v", err)
	}
	reasons, ok := err.Details["reasons"].([]map[string]any)
	if !ok || len(reasons) != 1 || reasons[0]["code"] != "last_master_required" || reasons[0]["message"] != "keep one master" {
		t.Fatalf("unexpected reasons %#v", err.Details["reasons"])
	}
}

func TestBlockedMultipleReasonsUseCombinedCode(t *testing.T) {
	err := Blocked("deletion_blocked", "blocked", New(409, "a", "first"), New(409, "b", "second"))
	if err.HTTPStatus != 409 || err.Code != "deletion_blocked" || err.Message != "blocked" {
		t.Fatalf("unexpected error %+v", err)
	}
	reasons, ok := err.Details["reasons"].([]map[string]any)
	if !ok || len(reasons) != 2 || reasons[0]["code"] != "a" || reasons[1]["code"] != "b" || reasons[1]["message"] != "second" {
		t.Fatalf("unexpected reasons %#v", err.Details["reasons"])
	}
}
