package branding

import (
	"bytes"
	"os"
	"testing"
)

func TestDefaultCompactLogoMatchesFrontendAsset(t *testing.T) {
	frontend, err := os.ReadFile("../../../frontend/public/brand/htumkr-symbol.png")
	if err != nil {
		t.Skipf("frontend asset not available: %v", err)
	}
	if !bytes.Equal(frontend, defaultCompactLogo) {
		t.Fatal("documentmark/htumkr-symbol.png differs from frontend/public/brand/htumkr-symbol.png; copy it again")
	}
}
