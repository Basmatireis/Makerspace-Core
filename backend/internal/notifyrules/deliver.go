package notifyrules

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	notifyrulesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

// statusSkippedOffline marks a person whose in-app notification was left out because it is for online accounts only
// and the person had none.
// onlineWindow is how recently an account must have polled with a visible tab to count as online.
const onlineWindow = 2 * time.Minute

const statusSkippedOffline = "skipped_offline"

// deliveryInput is one action ready to go out: its texts are filled and its recipients are resolved.
type deliveryInput struct {
	FiringID uuid.UUID
	Step     int
	Action   Action
	Link     string
	People   []uuid.UUID
	// Organizations are reached by the e-mail of an email action only.
	Organizations []uuid.UUID
	// Fallback marks the e-mail that follows an in-app notification nobody read: it goes only to people who did not
	// read it, and it skips the checks the notification already passed.
	Fallback bool
}

// target is how a person can be reached.
type target struct {
	accounts []uuid.UUID
	hasEmail bool
}

// channelDecision says whether an action on the channel reaches a person and, if not, why. A person without the
// required consent is never contacted; a person's own channel choice switches the action's channel off, and switching
// both off mutes the rule unless it is mandatory (then the rule's defaults stand).
func channelDecision(consentNeeded, granted bool, pref *Preference, mandatory bool, channel Channel) (bool, string) {
	if consentNeeded && !granted {
		return false, statusSkippedConsent
	}
	if pref != nil {
		effective := effectivePreference(*pref, mandatory)
		if (channel == ChannelInApp && !effective.InApp) || (channel == ChannelEmail && !effective.Email) {
			return false, statusSkippedMuted
		}
	}
	return true, statusSent
}

func effectivePreference(pref Preference, mandatory bool) Preference {
	if mandatory && !pref.InApp && !pref.Email {
		return Preference{InApp: true, Email: true}
	}
	return pref
}

// addedChannels lists the channels a person asked for that the rule's own actions do not use: somebody who switched
// e-mail on for a rule that only notifies in the app gets the same text by e-mail too.
func addedChannels(pref *Preference, mandatory bool, channel Channel, used map[Channel]bool) []Channel {
	if pref == nil {
		return nil
	}
	effective := effectivePreference(*pref, mandatory)
	var added []Channel
	if channel != ChannelInApp && effective.InApp && !used[ChannelInApp] {
		added = append(added, ChannelInApp)
	}
	if channel != ChannelEmail && effective.Email && !used[ChannelEmail] {
		added = append(added, ChannelEmail)
	}
	return added
}

// recipientRow is one line of the delivery log, written once the notification it points to exists.
type recipientRow struct {
	person  uuid.UUID
	channel Channel
	status  string
	inApp   bool
}

// deliver sends one action to its people: it checks conditions on the recipient, the category's consent, each
// person's own channel choice and the per-person throttle, creates one in-app notification for everybody reachable in
// the app and one queued mail per person, and writes a log line per person and channel. In-app notifications are
// written only for people with an enabled account; people without one can only receive e-mail.
func (d *Dispatcher) deliver(
	ctx context.Context,
	q *store,
	runtime *ruleRuntime,
	in deliveryInput,
	now time.Time,
) error {
	channel := in.Action.Channel
	if channel != ChannelInApp && channel != ChannelEmail {
		return nil
	}
	people := dedupePeople(in.People)
	organizations := dedupePeople(in.Organizations)
	if len(people) == 0 && (len(organizations) == 0 || channel != ChannelEmail) {
		return nil
	}
	targetRows, err := q.ListDeliveryTargets(ctx, uuidStrings(people))
	if err != nil {
		return fmt.Errorf("load recipients: %w", err)
	}
	targets := map[uuid.UUID]*target{}
	for _, row := range targetRows {
		found := targets[row.PersonID]
		if found == nil {
			found = &target{}
			targets[row.PersonID] = found
		}
		found.hasEmail = row.HasEmail
		if row.AccountID != nil {
			found.accounts = append(found.accounts, *row.AccountID)
		}
	}
	granted := map[uuid.UUID]bool{}
	if runtime.Consent {
		consented, err := q.ListGrantedConsentPeople(ctx, notifyrulesdb.ListGrantedConsentPeopleParams{
			CategoryID: *runtime.CategoryID, TextVersion: runtime.TextVersion, PersonIds: uuidStrings(people),
		})
		if err != nil {
			return fmt.Errorf("load consents: %w", err)
		}
		for _, person := range consented {
			granted[person] = true
		}
	}
	prefs, err := d.preferences(ctx, q, runtime, targets)
	if err != nil {
		return err
	}
	mailEnabled, mailChecked := false, false
	mailOn := func() (bool, error) {
		if !mailChecked {
			var err error
			if mailEnabled, err = q.MailDeliveryEnabled(ctx); err != nil {
				return false, fmt.Errorf("read mail delivery switch: %w", err)
			}
			mailChecked = true
		}
		return mailEnabled, nil
	}

	// An online-only notification reaches only accounts that had the application open in a visible tab just now.
	online := map[uuid.UUID]bool{}
	onlineOnly := channel == ChannelInApp && !in.Fallback && in.Action.InApp != nil && in.Action.InApp.OnlineOnly
	if onlineOnly {
		var accounts []uuid.UUID
		for _, reach := range targets {
			accounts = append(accounts, reach.accounts...)
		}
		found, err := q.ListOnlineAccounts(ctx, notifyrulesdb.ListOnlineAccountsParams{
			AccountIds: uuidStrings(accounts), Since: now.Add(-onlineWindow),
		})
		if err != nil {
			return fmt.Errorf("load online accounts: %w", err)
		}
		for _, account := range found {
			online[account] = true
		}
	}
	inAppAccounts := map[uuid.UUID][]uuid.UUID{}

	var rows []recipientRow
	var inAppPeople, mailPeople []uuid.UUID
	for _, person := range people {
		reach := targets[person]
		if reach == nil {
			continue
		}
		if !in.Fallback && runtime.Pass != nil && !runtime.Pass(person) {
			rows = append(rows, recipientRow{person: person, channel: channel, status: statusSkippedCondition})
			continue
		}
		pref := prefs[person]
		var channels []Channel
		ok, status := channelDecision(runtime.Consent, granted[person], pref, runtime.Mandatory, channel)
		if ok {
			channels = append(channels, channel)
		} else {
			rows = append(rows, recipientRow{person: person, channel: channel, status: status})
		}
		if status != statusSkippedConsent && !in.Fallback {
			channels = append(channels, addedChannels(pref, runtime.Mandatory, channel, runtime.Channels)...)
		}
		if len(channels) == 0 {
			continue
		}
		if runtime.PersonThrottle != nil && !in.Fallback {
			claimed, err := q.ClaimThrottle(ctx, notifyrulesdb.ClaimThrottleParams{
				RuleID: runtime.ID, SubjectKey: "person:" + person.String(), Now: now,
				WindowStart: now.Add(-*runtime.PersonThrottle),
			})
			if err != nil {
				return fmt.Errorf("claim person throttle: %w", err)
			}
			if claimed == 0 {
				rows = append(rows, recipientRow{person: person, channel: channel, status: statusThrottled})
				continue
			}
		}
		for _, c := range channels {
			switch c {
			case ChannelInApp:
				accounts := reach.accounts
				if onlineOnly && len(accounts) > 0 {
					accounts = slices.DeleteFunc(slices.Clone(accounts), func(account uuid.UUID) bool { return !online[account] })
					if len(accounts) == 0 {
						rows = append(rows, recipientRow{person: person, channel: ChannelInApp, status: statusSkippedOffline})
						continue
					}
				}
				if len(accounts) > 0 {
					inAppPeople = append(inAppPeople, person)
					inAppAccounts[person] = accounts
				}
			case ChannelEmail:
				if !reach.hasEmail {
					continue
				}
				on, err := mailOn()
				if err != nil {
					return err
				}
				if on {
					mailPeople = append(mailPeople, person)
				}
			}
		}
	}

	if runtime.Stats != nil {
		if runtime.Stats.Sent == nil {
			runtime.Stats.Sent = map[Channel]int{}
		}
		runtime.Stats.Sent[ChannelInApp] += len(inAppPeople)
		runtime.Stats.Sent[ChannelEmail] += len(mailPeople)
	}
	sentStatus := statusSent
	if in.Fallback {
		sentStatus = statusFallback
	}
	var notificationID *uuid.UUID
	if len(inAppPeople) > 0 {
		id := ids.New()
		var accounts []uuid.UUID
		for _, person := range inAppPeople {
			accounts = append(accounts, inAppAccounts[person]...)
		}
		params := notifyrulesdb.InsertRuleNotificationParams{
			ID: id, Title: in.Action.Title, Body: in.Action.Body, Link: optionalText(in.Link), CreatedAt: now,
			ExpiresAt: now.Add(notificationRetention), RuleID: &runtime.ID, FiringID: &in.FiringID,
			CategoryID: runtime.CategoryID,
		}
		appearanceParams(&params, in.Action.InApp, in.Link)
		if err = q.InsertRuleNotification(ctx, params); err != nil {
			return fmt.Errorf("insert rule notification: %w", err)
		}
		if err = q.InsertRuleNotificationRecipients(ctx, notifyrulesdb.InsertRuleNotificationRecipientsParams{
			NotificationID: id, AccountIds: uuidStrings(dedupePeople(accounts)),
		}); err != nil {
			return fmt.Errorf("insert rule notification recipients: %w", err)
		}
		notificationID = &id
		for _, person := range inAppPeople {
			rows = append(rows, recipientRow{person: person, channel: ChannelInApp, status: sentStatus, inApp: true})
		}
		if err = d.scheduleFallback(ctx, q, in, inAppPeople, id, now); err != nil {
			return err
		}
	}
	mailLink := optionalText(mailPath(in.Link))
	for _, person := range mailPeople {
		person := person
		if err = q.InsertRuleMail(ctx, notifyrulesdb.InsertRuleMailParams{
			ID: ids.New(), PersonID: &person, Subject: Clip(in.Action.Title, MaxTitleLength),
			Body: Clip(in.Action.Body, MaxBodyLength), Link: mailLink, FiringID: &in.FiringID,
		}); err != nil {
			return fmt.Errorf("queue rule mail: %w", err)
		}
		rows = append(rows, recipientRow{person: person, channel: ChannelEmail, status: sentStatus})
	}
	if len(organizations) > 0 {
		on, err := mailOn()
		if err != nil {
			return err
		}
		for _, organization := range organizations {
			if !on {
				break
			}
			organization := organization
			if err = q.InsertRuleMail(ctx, notifyrulesdb.InsertRuleMailParams{
				ID: ids.New(), OrganizationID: &organization, Subject: Clip(in.Action.Title, MaxTitleLength),
				Body: Clip(in.Action.Body, MaxBodyLength), Link: mailLink, FiringID: &in.FiringID,
			}); err != nil {
				return fmt.Errorf("queue rule mail: %w", err)
			}
		}
	}
	for _, row := range rows {
		person := row.person
		var notification *uuid.UUID
		if row.inApp {
			notification = notificationID
		}
		if err = q.InsertFiringRecipient(ctx, notifyrulesdb.InsertFiringRecipientParams{
			ID: ids.New(), FiringID: in.FiringID, PersonID: &person, Channel: string(row.channel), Step: int32(in.Step),
			Status: row.status, NotificationID: notification, SentAt: now,
		}); err != nil {
			return fmt.Errorf("log recipient: %w", err)
		}
	}
	return nil
}

// appearanceParams copies how the action wants its in-app notification to look; without options it keeps the
// database defaults of a plain pop-up. A link button without a usable link falls back to no button.
func appearanceParams(params *notifyrulesdb.InsertRuleNotificationParams, options *InAppOptions, link string) {
	params.Appearance, params.Level, params.ButtonKind = string(AppearanceToast), string(LevelInfo), string(ButtonNone)
	if options == nil {
		return
	}
	params.Appearance, params.Level = string(options.Appearance), string(options.Level)
	if options.Appearance == AppearanceToast {
		seconds := int32(options.ToastSeconds) //nolint:gosec // validated to 0, 5, 10 or 30
		params.ToastSeconds = &seconds
	}
	params.OnlyButtonCloses, params.AllowLater = options.OnlyButtonCloses, options.AllowLater
	button := options.Button
	if button == nil || button.Kind == ButtonNone {
		return
	}
	params.ButtonKind = string(button.Kind)
	params.ButtonLabel = optionalText(Clip(strings.TrimSpace(button.Label), MaxButtonLabelLength))
	if button.Kind == ButtonLink {
		if link == "" {
			params.ButtonKind, params.ButtonLabel = string(ButtonNone), nil
			return
		}
		params.ButtonLink = &link
	}
}

// preferences loads the channel choices of the people's accounts for a central rule, by person. Personal rules have
// none: their owner changes or deletes the rule itself.
func (d *Dispatcher) preferences(
	ctx context.Context,
	q *store,
	runtime *ruleRuntime,
	targets map[uuid.UUID]*target,
) (map[uuid.UUID]*Preference, error) {
	prefs := map[uuid.UUID]*Preference{}
	if runtime.Personal {
		return prefs, nil
	}
	var accounts []uuid.UUID
	for _, reach := range targets {
		accounts = append(accounts, reach.accounts...)
	}
	if len(accounts) == 0 {
		return prefs, nil
	}
	rows, err := q.ListPreferencesOfRule(ctx, notifyrulesdb.ListPreferencesOfRuleParams{
		RuleID: runtime.ID, AccountIds: uuidStrings(accounts),
	})
	if err != nil {
		return nil, fmt.Errorf("load channel choices: %w", err)
	}
	byAccount := map[uuid.UUID]Preference{}
	for _, row := range rows {
		byAccount[row.AccountID] = Preference{InApp: row.InApp, Email: row.Email}
	}
	for person, reach := range targets {
		for _, account := range reach.accounts {
			if pref, ok := byAccount[account]; ok {
				prefs[person] = &pref
				break
			}
		}
	}
	return prefs, nil
}

// scheduleFallback queues the e-mail that follows an in-app notification when nobody read it in time.
func (d *Dispatcher) scheduleFallback(
	ctx context.Context,
	q *store,
	in deliveryInput,
	people []uuid.UUID,
	notificationID uuid.UUID,
	now time.Time,
) error {
	options := in.Action.InApp
	if in.Fallback || in.Action.Channel != ChannelInApp || options == nil || options.EmailFallbackMinutes == nil ||
		*options.EmailFallbackMinutes <= 0 {
		return nil
	}
	mail := in.Action
	mail.Channel, mail.InApp, mail.DelayMinutes = ChannelEmail, nil, 0
	due := now.Add(time.Duration(*options.EmailFallbackMinutes) * time.Minute)
	return d.schedule(ctx, q, in.FiringID, in.Step, due, mail, dedupePeople(people), pendingItem{
		Link: in.Link, Fallback: true, NotificationID: &notificationID,
	})
}

func optionalText(text string) *string {
	if text == "" {
		return nil
	}
	return &text
}

// mailPath is the link a mail may carry: only application paths, which the mail layout turns into addresses.
func mailPath(link string) string {
	if strings.HasPrefix(link, "/") {
		return link
	}
	return ""
}
