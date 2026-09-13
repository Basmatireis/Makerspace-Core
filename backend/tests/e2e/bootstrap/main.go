// Command bootstrap creates the deterministic master fixture used only by the
// isolated full-stack browser suite. It is compiled in the development image
// and is never copied into the production runtime image.
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
)

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
		FirstName:    "E2E",
		LastName:     "Administrator",
		ContactEmail: "e2e-master-contact@example.test",
		LoginEmail:   "e2e-master@example.test",
		Password:     "E2E master workshop passphrase 42",
	})
	if err != nil {
		return err
	}
	fmt.Println("created isolated E2E master account", accountID)
	return nil
}
