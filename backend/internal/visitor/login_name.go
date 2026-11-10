package visitor

import (
	"context"
	"crypto/rand"
	"math/big"
	"slices"
	"strconv"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	visitordb "github.com/Basmatireis/Makerspace-Core/backend/internal/visitor/db"
	"golang.org/x/text/unicode/norm"
)

// maxLoginNameSuggestions bounds the attempts; past it the visitor types a name of their own.
const maxLoginNameSuggestions = 20

var germanTransliterations = strings.NewReplacer("ä", "ae", "ö", "oe", "ü", "ue", "ß", "ss")

// loginNamePart lowers a name, writes German umlauts out, drops accents and keeps letters, digits and hyphens:
// "Anna-Lena" → "anna-lena", "Müller" → "mueller", "José" → "jose".
func loginNamePart(name string) string {
	lowered := germanTransliterations.Replace(strings.ToLower(strings.TrimSpace(name)))
	var out strings.Builder
	// Decomposing splits "é" into "e" and a combining accent, which is dropped with every other character.
	for _, r := range norm.NFD.String(lowered) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' {
			out.WriteRune(r)
		}
	}
	return strings.Trim(out.String(), "-")
}

// BaseLoginName builds "firstname.lastname" from a visitor's name, or "" when nothing usable is left.
func BaseLoginName(firstName, lastName string) string {
	parts := make([]string, 0, 2)
	for _, name := range []string{firstName, lastName} {
		if part := loginNamePart(name); part != "" {
			parts = append(parts, part)
		}
	}
	return strings.Join(parts, ".")
}

// SuggestLoginName proposes a PIN login name for the visitor on this enrollment context: the base name, or, when that
// is taken, the base name with a random number appended. A random number instead of 2, 3, … keeps the answer from
// telling which numbered names exist; it says no more than a submission with the base name would. It creates nothing;
// Submit checks the name again.
func (s *Service) SuggestLoginName(ctx context.Context, _ Context, firstName, lastName string) (string, error) {
	queries := visitordb.New(s.pool)
	configuration, err := s.loadConfiguration(ctx, queries)
	if err != nil {
		return "", err
	}
	if !configuration.Enabled || !slices.Contains(configuration.AllowedMethods, MethodPIN) {
		return "", apperror.PermissionDenied
	}
	base := BaseLoginName(firstName, lastName)
	if len(base) > 60 {
		base = strings.TrimRight(base[:60], ".-")
	}
	if _, _, err := auth.NormalizePINLoginName(base); err != nil {
		return "", apperror.InvalidField("no login name can be built from this name")
	}
	candidate := base
	for attempt := 0; attempt < maxLoginNameSuggestions; attempt++ {
		normalized := strings.ToLower(candidate)
		taken, err := queries.PINLoginNameTaken(ctx, &normalized)
		if err != nil {
			return "", err
		}
		if !taken {
			return candidate, nil
		}
		// A login name signs in together with a PIN, so its number is not left to a predictable generator.
		suffix, err := rand.Int(rand.Reader, big.NewInt(998))
		if err != nil {
			return "", err
		}
		candidate = base + strconv.FormatInt(2+suffix.Int64(), 10)
	}
	return "", apperror.InvalidField("no free login name found; choose one yourself")
}
