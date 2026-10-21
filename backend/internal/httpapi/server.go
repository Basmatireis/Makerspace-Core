package httpapi

import (
	"context"
	"fmt"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/attendance"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/branding"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/dashboard"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	mailservice "github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifications"
	oidcservice "github.com/Basmatireis/Makerspace-Core/backend/internal/oidc"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/opendays"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/orders"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ratelimit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printartifacts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	scimservice "github.com/Basmatireis/Makerspace-Core/backend/internal/scim"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/staffing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/streaminggateways"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/supervisors"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/surveys"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/visitor"
	"github.com/jackc/pgx/v5/pgxpool"
)

const apiBasePath = "/api/v1"

// Server translates the generated OpenAPI transport contract into feature
// service calls. Business validation, authorization, transactions, and audit
// writes deliberately remain in those services.
type Server struct {
	routes            routePolicy
	pool              *pgxpool.Pool
	config            config.Config
	auth              *auth.Service
	people            *people.Service
	accounts          *accounts.Service
	permissions       *authorization.Service
	roles             *roles.Service
	audit             *audit.Service
	opendays          *opendays.Service
	events            *events.Service
	managedDevices    *manageddevices.Service
	mail              *mailservice.Service
	files             *files.Service
	laborordnung      *laborordnung.Service
	orders            *orders.Service
	machineLogbook    *machinelogbook.Service
	printArtifacts    *printartifacts.Service
	printing          *printing.Service
	printerConnectors *printerconnectors.Service
	streamingGateways *streaminggateways.Service
	supervisors       *supervisors.Service
	staffing          *staffing.Service
	dashboard         *dashboard.Service
	oidc              *oidcservice.Service
	scim              *scimservice.Service
	visitor           *visitor.Service
	branding          *branding.Service
	signage           *signage.Service
	attendance        *attendance.Service
	surveys           *surveys.Service
	deviceRates       deviceRateLimits
	// gatewayFailures counts failed streaming-gateway authentications and enrollments per client IP.
	gatewayFailures *ratelimit.Limiter
}

func NewServer(pool *pgxpool.Pool, cfg config.Config) (*Server, error) {
	mailer, err := mailservice.NewService(pool, cfg.EncryptionKeys)
	if err != nil {
		return nil, fmt.Errorf("initialize mail service: %w", err)
	}
	fileStore, err := storage.NewFromConfig(context.Background(), cfg)
	if err != nil {
		return nil, err
	}
	fileService := files.NewService(pool, fileStore)
	brandingService := branding.NewService(pool, fileService)
	notifier := notifications.NewService(mailer, brandingService)
	authService, err := auth.NewService(pool, cfg, notifier)
	if err != nil {
		return nil, fmt.Errorf("initialize authentication: %w", err)
	}
	openDaysService, err := opendays.NewService(pool, cfg)
	if err != nil {
		return nil, fmt.Errorf("initialize Open Days: %w", err)
	}
	eventService, err := events.NewService(pool, cfg, fileService)
	if err != nil {
		return nil, fmt.Errorf("initialize Events: %w", err)
	}
	staffingService, err := staffing.NewService(pool, cfg)
	if err != nil {
		return nil, fmt.Errorf("initialize staffing: %w", err)
	}
	oidcService, err := oidcservice.NewService(pool, cfg, authService)
	if err != nil {
		return nil, fmt.Errorf("initialize OIDC: %w", err)
	}
	if err := oidcService.ValidateConfiguration(context.Background()); err != nil {
		return nil, fmt.Errorf("validate OIDC configuration: %w", err)
	}
	labRulesService := laborordnung.NewService(pool, fileService)
	machineLogbook := machinelogbook.NewService(pool)
	printingService := printing.NewService(pool)
	printerConnectorService, err := printerconnectors.NewService(pool, printingService, cfg.EncryptionKeys)
	if err != nil {
		return nil, fmt.Errorf("initialize printer connectors: %w", err)
	}
	streamingGatewayService, err := streaminggateways.NewService(pool, cfg.EncryptionKeys)
	if err != nil {
		return nil, fmt.Errorf("initialize streaming gateways: %w", err)
	}
	signageService, err := signage.NewService(
		pool,
		cfg,
		fileService,
		signage.WithPublicCalendar(publicCalendar{openDays: openDaysService, events: eventService}),
		signage.WithStreamIssuer(streamIssuer{gateways: streamingGatewayService}),
	)
	if err != nil {
		return nil, fmt.Errorf("initialize signage: %w", err)
	}
	surveyService := surveys.NewService(pool, cfg, notifier)
	ordersService := orders.NewService(pool, machineLogbook)
	return &Server{
		pool:              pool,
		config:            cfg,
		auth:              authService,
		people:            people.NewService(pool, fileService),
		accounts:          accounts.NewService(pool, cfg, notifier),
		permissions:       authorization.NewService(),
		roles:             roles.NewService(pool),
		audit:             audit.NewService(pool),
		opendays:          openDaysService,
		events:            eventService,
		managedDevices:    manageddevices.NewService(pool),
		mail:              mailer,
		files:             fileService,
		laborordnung:      labRulesService,
		machineLogbook:    machineLogbook,
		printArtifacts:    printartifacts.NewService(pool, fileService, machineLogbook),
		printing:          printingService,
		printerConnectors: printerConnectorService,
		streamingGateways: streamingGatewayService,
		orders:            ordersService,
		supervisors:       supervisors.NewService(pool, staffingService),
		staffing:          staffingService,
		dashboard:         dashboard.NewService(pool, staffingService, openDaysService, eventService, ordersService, machineLogbook),
		oidc:              oidcService,
		scim:              scimservice.NewService(pool),
		visitor:           visitor.NewService(pool, cfg, fileService, labRulesService, notifier),
		branding:          brandingService,
		signage:           signageService,
		surveys:           surveyService,
		deviceRates:       newDeviceRateLimits(),
		gatewayFailures:   ratelimit.New(gatewayFailuresPerWindow, gatewayFailureWindow),
		attendance:        attendance.NewService(pool, authService, labRulesService, surveyService),
	}, nil
}
