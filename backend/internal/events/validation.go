package events

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
)

var internationalPhone = regexp.MustCompile(`^\+[0-9]{8,15}$`)
var localPhone = regexp.MustCompile(`^[0-9]{6,15}$`)

func cleanRequired(value, field string, max int) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || utf8.RuneCountInString(value) > max {
		return "", validation(fmt.Sprintf("%s is required and limited to %d characters", field, max))
	}
	return value, nil
}

func cleanOptional(value *string, max int) (*string, error) {
	if value == nil {
		return nil, nil
	}
	clean := strings.TrimSpace(*value)
	if clean == "" {
		return nil, nil
	}
	if utf8.RuneCountInString(clean) > max {
		return nil, validation(fmt.Sprintf("value is limited to %d characters", max))
	}
	return &clean, nil
}

func normalizePhone(raw string) (display, normalized string, err error) {
	display = strings.TrimSpace(raw)
	if display == "" {
		return "", "", errors.New("phone is required")
	}
	normalized = strings.NewReplacer(" ", "", "-", "", "(", "", ")", "", ".", "", "/", "").Replace(display)
	if strings.HasPrefix(normalized, "00") {
		normalized = "+" + strings.TrimPrefix(normalized, "00")
	}
	if !internationalPhone.MatchString(normalized) && !localPhone.MatchString(normalized) {
		return "", "", errors.New("phone is invalid")
	}
	return display, normalized, nil
}

func normalizeContact(email, phone *string) (emailDisplay, emailNormalized, phoneDisplay, phoneNormalized *string, err error) {
	if email != nil && strings.TrimSpace(*email) != "" {
		display, normalized, emailErr := security.NormalizeEmail(*email)
		if emailErr != nil {
			return nil, nil, nil, nil, validation("email is invalid")
		}
		emailDisplay, emailNormalized = &display, &normalized
	}
	if phone != nil && strings.TrimSpace(*phone) != "" {
		display, normalized, phoneErr := normalizePhone(*phone)
		if phoneErr != nil {
			return nil, nil, nil, nil, validation("phone is invalid")
		}
		phoneDisplay, phoneNormalized = &display, &normalized
	}
	if emailNormalized == nil && phoneNormalized == nil {
		return nil, nil, nil, nil, validation("email or phone is required")
	}
	return
}

func validateInterval(startsAt, endsAt time.Time) error {
	if startsAt.IsZero() || endsAt.IsZero() || !endsAt.After(startsAt) {
		return validation("endsAt must be after startsAt")
	}
	return nil
}

func validateVersion(version int64) error {
	if version < 1 {
		return validation("expectedVersion must be positive")
	}
	return nil
}

func validation(message string) error { return apperror.New(422, "validation_failed", message) }

func signupUnavailable() error {
	return apperror.New(409, "signup_unavailable", "Signup is unavailable")
}

func lockKeys(values ...*string) []int64 {
	keys := make([]int64, 0, len(values))
	seen := map[int64]struct{}{}
	for _, value := range values {
		if value == nil {
			continue
		}
		digest := sha256.Sum256([]byte(*value))
		key := int64(binary.BigEndian.Uint64(digest[:8]))
		if _, ok := seen[key]; !ok {
			seen[key] = struct{}{}
			keys = append(keys, key)
		}
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	return keys
}
