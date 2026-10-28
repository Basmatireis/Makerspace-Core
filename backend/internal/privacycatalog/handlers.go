package privacycatalog

import (
	"github.com/Basmatireis/Makerspace-Core/backend/internal/attendance"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/oidc"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printartifacts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/runrecordings"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/surveys"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/visitor"
)

// RegisterBuiltinHandlers attaches the retention handlers of the built-in
// modules to the privacy service. runRecordings supplies the timelapse handler
// and the configured legacy timelapse period.
func RegisterBuiltinHandlers(service *privacy.Service, runRecordings *runrecordings.Service, periods privacy.LegacyPeriods) {
	service.Register(AuthSessions, auth.SessionRetention())
	service.Register(AuthPendingState, pendingState())
	service.Register(SurveyInvitations, surveys.InvitationRetention())
	service.Register(AttendanceVisits, attendance.VisitRetention(service.Now))
	service.Register(AuditEvents, privacy.AuditEventRetention())
	service.Register(EventExternalSignups, events.SignupRetention())
	service.Register(InboxNotifications, inbox.NotificationRetention())
	service.Register(SignageAnnouncements, signage.AnnouncementRetention())
	service.Register(PrinterTelemetry, printerconnectors.TelemetryRetention())
	service.Register(PrintArtifacts, printartifacts.ArtifactRetention())
	if runRecordings != nil {
		service.Register(RunTimelapses, runRecordings.TimelapseRetention())
		periods.TimelapseRetention = runRecordings.ConfiguredTimelapseRetention
	}
	service.SetLegacyPeriods(periods)
}

// pendingState combines the sign-in, passkey, OIDC and kiosk enrollment
// expiries that no routine pruned before the privacy registry.
func pendingState() privacy.RetentionHandler {
	parts := []privacy.RetentionHandler{auth.PendingStateRetention(), oidc.FlowRetention(), visitor.EnrollmentContextRetention()}
	return privacy.Combine(parts...)
}
