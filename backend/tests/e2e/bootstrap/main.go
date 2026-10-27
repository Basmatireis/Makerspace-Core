// Command bootstrap creates the deterministic master fixture used only by the
// isolated full-stack browser suite. It is compiled in the development image
// and is never copied into the production runtime image.
package main

import (
	"context"
	"encoding/base32"
	"fmt"
	"os"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
)

// masterTOTPSecret is a test-only base32 secret; keep it equal to frontend/e2e/totp.ts.
const masterTOTPSecret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "e2e bootstrap:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if cfg.Environment != "test" {
		return fmt.Errorf("APP_ENV must be test")
	}
	if err := cfg.ValidateDatabase(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := database.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	accountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName:  "E2E",
		LastName:   "Administrator",
		LoginEmail: "e2e-master@example.test",
		Password:   "E2E master workshop passphrase 42",
	})
	if err != nil {
		return err
	}
	// Masters must use a second factor: enroll the fixed, test-only authenticator secret that
	// frontend/e2e/totp.ts shares, so the browser suite can complete the second-factor step.
	authService, err := auth.NewService(pool, cfg, nil)
	if err != nil {
		return err
	}
	secret, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(masterTOTPSecret)
	if err != nil {
		return err
	}
	if err := authService.EnrollFixtureTOTP(ctx, accountID, secret); err != nil {
		return err
	}
	fmt.Println("created isolated E2E master account", accountID)
	return nil
}
