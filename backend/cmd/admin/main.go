package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	oidcservice "github.com/Basmatireis/Makerspace-Core/backend/internal/oidc"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"golang.org/x/term"
)

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "admin:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New("usage: admin <bootstrap-master|recover-master|reset-password|cleanup|verify-files|reencrypt-oidc-secrets|migrate-files-local-to-s3>")
	}
	if args[0] == "reset-password" && len(args) != 1 {
		return errors.New("reset-password accepts no flags, password arguments, environment values, or piped input")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if err := cfg.ValidateDatabase(); err != nil {
		return err
	}
	pool, err := database.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	service := admin.NewService(pool)

	switch args[0] {
	case "bootstrap-master":
		if len(args) != 1 {
			return errors.New("bootstrap-master accepts no flags or piped values")
		}
		input, err := promptBootstrap()
		if err != nil {
			return err
		}
		id, err := service.BootstrapMaster(ctx, input)
		if err != nil {
			return err
		}
		fmt.Println("master account created:", id)
		return nil
	case "recover-master":
		if len(args) != 1 {
			return errors.New("recover-master accepts no flags or piped values")
		}
		email, password, err := promptRecovery()
		if err != nil {
			return err
		}
		id, err := service.RecoverMaster(ctx, email, password)
		if err != nil {
			return err
		}
		fmt.Println("master account recovered:", id)
		return nil
	case "reset-password":
		identifier, password, err := promptExistingAccountPasswordReset()
		if err != nil {
			return err
		}
		id, err := service.ResetPassword(ctx, identifier, password)
		if err != nil {
			return err
		}
		fmt.Println("existing account password reset:", id)
		return nil
	case "cleanup":
		flags := flag.NewFlagSet("cleanup", flag.ContinueOnError)
		auditBeforeRaw := flags.String("audit-before", "", "optional RFC3339 audit cutoff")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		var auditBefore time.Time
		if *auditBeforeRaw != "" {
			auditBefore, err = time.Parse(time.RFC3339, *auditBeforeRaw)
			if err != nil {
				return fmt.Errorf("parse audit cutoff: %w", err)
			}
		} else if cfg.AuditRetention > 0 {
			auditBefore = time.Now().UTC().Add(-cfg.AuditRetention)
		}
		sessions, resets, events, err := service.Cleanup(ctx, time.Now().UTC(), auditBefore)
		if err != nil {
			return err
		}
		fmt.Printf("deleted sessions=%d reset_tokens=%d audit_events=%d\n", sessions, resets, events)
		return nil
	case "verify-files":
		if len(args) != 1 {
			return errors.New("verify-files accepts no flags")
		}
		store, err := storage.NewFromConfig(ctx, cfg)
		if err != nil {
			return err
		}
		invalid, err := files.NewService(pool, store).Verify(ctx)
		if err != nil {
			return err
		}
		if len(invalid) != 0 {
			for _, id := range invalid {
				fmt.Println("invalid file:", id)
			}
			return fmt.Errorf("file integrity verification failed for %d database-referenced object(s)", len(invalid))
		}
		fmt.Println("verified all database-referenced files")
		return nil
	case "reencrypt-oidc-secrets":
		if len(args) != 1 {
			return errors.New("reencrypt-oidc-secrets accepts no flags or piped values")
		}
		oidcService, err := oidcservice.NewService(pool, cfg, nil)
		if err != nil {
			return err
		}
		count, err := oidcService.ReencryptProviderSecrets(ctx)
		if err != nil {
			return err
		}
		fmt.Printf("reencrypted oidc_provider_secrets=%d\n", count)
		return nil
	case "migrate-files-local-to-s3":
		if len(args) != 1 {
			return errors.New("migrate-files-local-to-s3 accepts no flags")
		}
		if cfg.LocalStorageRoot == "" || cfg.S3Region == "" || cfg.S3Bucket == "" {
			return errors.New("LOCAL_STORAGE_ROOT, S3_REGION, and S3_BUCKET are required")
		}
		source, err := storage.NewLocal(cfg.LocalStorageRoot)
		if err != nil {
			return err
		}
		destination, err := storage.NewS3(ctx, storage.S3Config{Endpoint: cfg.S3Endpoint, Region: cfg.S3Region, Bucket: cfg.S3Bucket, AccessKeyID: cfg.S3AccessKeyID, SecretAccessKey: cfg.S3SecretAccessKey, UsePathStyle: cfg.S3UsePathStyle, DisableTLS: cfg.S3DisableTLS})
		if err != nil {
			return err
		}
		count, err := files.NewService(pool, source).CopyStorage(ctx, source, destination)
		if err != nil {
			return err
		}
		fmt.Printf("copied_and_verified files=%d\n", count)
		return nil
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func promptBootstrap() (admin.BootstrapInput, error) {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return admin.BootstrapInput{}, errors.New("bootstrap-master requires an interactive terminal")
	}
	reader := bufio.NewReader(os.Stdin)
	first, err := promptLine(reader, "First name: ")
	if err != nil {
		return admin.BootstrapInput{}, err
	}
	last, err := promptLine(reader, "Last name: ")
	if err != nil {
		return admin.BootstrapInput{}, err
	}
	contactEmail, err := promptLine(reader, "Contact email: ")
	if err != nil {
		return admin.BootstrapInput{}, err
	}
	loginEmail, err := promptLine(reader, "Login email: ")
	if err != nil {
		return admin.BootstrapInput{}, err
	}
	password, err := promptPasswordTwice()
	if err != nil {
		return admin.BootstrapInput{}, err
	}
	return admin.BootstrapInput{FirstName: first, LastName: last, ContactEmail: contactEmail, LoginEmail: loginEmail, Password: password}, nil
}

func promptRecovery() (string, string, error) {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return "", "", errors.New("recover-master requires an interactive terminal")
	}
	reader := bufio.NewReader(os.Stdin)
	email, err := promptLine(reader, "Existing account login email: ")
	if err != nil {
		return "", "", err
	}
	password, err := promptPasswordTwice()
	return email, password, err
}

func promptExistingAccountPasswordReset() (string, string, error) {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return "", "", errors.New("reset-password requires an interactive terminal; stdin pipes are refused")
	}
	reader := bufio.NewReader(os.Stdin)
	identifier, err := promptLine(reader, "Existing account login email or identifier: ")
	if err != nil {
		return "", "", err
	}
	password, err := promptPasswordTwice()
	return identifier, password, err
}

func promptLine(reader *bufio.Reader, label string) (string, error) {
	fmt.Fprint(os.Stderr, label)
	value, err := reader.ReadString('\n')
	return strings.TrimSpace(value), err
}

func promptPasswordTwice() (string, error) {
	fmt.Fprint(os.Stderr, "Password: ")
	first, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	fmt.Fprint(os.Stderr, "Confirm password: ")
	second, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	if string(first) != string(second) {
		return "", errors.New("passwords do not match")
	}
	return string(first), nil
}
