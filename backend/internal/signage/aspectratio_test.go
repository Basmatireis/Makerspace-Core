package signage

import (
	"errors"
	"net/http"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

func TestCheckAspectRatioReduces(t *testing.T) {
	cases := []struct {
		in, want AspectRatio
	}{
		{AspectRatio{1920, 1080}, AspectRatio{16, 9}},
		{AspectRatio{1080, 1920}, AspectRatio{9, 16}},
		{AspectRatio{16, 9}, AspectRatio{16, 9}},
		{AspectRatio{3440, 1440}, AspectRatio{43, 18}},
		{AspectRatio{5120, 1440}, AspectRatio{32, 9}},
		{AspectRatio{100, 100}, AspectRatio{1, 1}},
		{AspectRatio{100, 1}, AspectRatio{100, 1}},
	}
	for _, c := range cases {
		got, err := checkAspectRatio(c.in)
		if err != nil || got != c.want {
			t.Errorf("checkAspectRatio(%s) = %s, %v; want %s", c.in, got, err, c.want)
		}
	}
}

func TestCheckAspectRatioRejects(t *testing.T) {
	for _, ratio := range []AspectRatio{{0, 9}, {16, 0}, {-16, 9}, {1366, 768}, {101, 1}, {1, 101}} {
		_, err := checkAspectRatio(ratio)
		var appErr *apperror.Error
		if !errors.As(err, &appErr) || appErr.HTTPStatus != http.StatusUnprocessableEntity {
			t.Errorf("checkAspectRatio(%s) = %v, want 422", ratio, err)
		}
	}
}
