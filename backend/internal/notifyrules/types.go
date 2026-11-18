package notifyrules

import (
	"time"

	"github.com/google/uuid"
)

// Basis is the legal basis a category sends on.
type Basis string

const (
	// BasisRequired is service communication that needs no consent.
	BasisRequired Basis = "required"
	// BasisConsent reaches only people who said yes to the category's current text.
	BasisConsent Basis = "consent"
)

// ServiceCategoryKey marks the one category that cannot change or disappear.
const ServiceCategoryKey = "service"

// Consent places, where a person answered.
type ConsentPlace string

const (
	PlaceApp     ConsentPlace = "app"
	PlaceKiosk   ConsentPlace = "kiosk"
	PlaceProfile ConsentPlace = "profile"
)

// Limits on the number of rules and categories.
const (
	MaxCentralRules  = 500
	MaxPersonalRules = 30
	MaxCategories    = 50
	MaxCategoryName  = 80
	MaxCategoryText  = 600
	sparklineDays    = 14
	statsDays        = 30
)

// Category groups rules by the reason a person may be contacted.
type Category struct {
	ID            uuid.UUID
	Key           *string
	Name          string
	Description   string
	Basis         Basis
	TextVersion   int
	TextChangedAt time.Time
	Position      int
	RuleCount     int64
	Version       int64
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// CategoryInput creates a category (Basis is used) or changes one (Basis is ignored: the basis never changes).
// AskAgain bumps the text version so everyone is asked for consent again.
type CategoryInput struct {
	Name        string
	Description string
	Basis       Basis
	Position    int
	AskAgain    bool
}

// RuleInput is what a person submits for a rule. Category and mandatory apply to central rules only.
type RuleInput struct {
	Name        string
	Description string
	CategoryID  *uuid.UUID
	Enabled     bool
	Mandatory   bool
	Definition  Definition
}

// RuleStats summarizes the recent firings of a rule.
type RuleStats struct {
	Fired30     int64
	LastFiredAt *time.Time
	// Sparkline counts the firings of the last 14 days, oldest first.
	Sparkline []int64
}

// Rule is a stored rule. Warnings are not stored: they list placeholders that stay visible and are filled when a
// rule is validated.
type Rule struct {
	ID             uuid.UUID
	OwnerAccountID *uuid.UUID
	Name           string
	Description    string
	CategoryID     *uuid.UUID
	Enabled        bool
	Mandatory      bool
	SystemKey      *string
	Definition     Definition
	LastFiredAt    *time.Time
	Stats          *RuleStats
	Warnings       []string
	Version        int64
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// ConsentEntry is a category with a person's latest answer. Current says whether the answer was given to the
// category's present text; Granted is nil while the person never answered.
type ConsentEntry struct {
	Category   Category
	Granted    *bool
	AnsweredAt *time.Time
	Current    bool
}

// ConsentAnswer is one answer submitted by a person.
type ConsentAnswer struct {
	CategoryID uuid.UUID
	Granted    bool
}

// ReachingRule is a central rule that notifies the person, with why and over which channels.
type ReachingRule struct {
	RuleID       uuid.UUID
	Name         string
	Description  string
	CategoryID   uuid.UUID
	CategoryName string
	Mandatory    bool
	// Why lists the reasons the rule reaches the person, in words.
	Why             []string
	DefaultChannels []Channel
	// EffectiveChannels are the person's own choice, or the defaults without one.
	EffectiveChannels []Channel
	// BlockedByConsent says the rule's category needs a consent the person has not given.
	BlockedByConsent bool
	// TriggerSummary is the rule's "When" line as the rules list shows it.
	TriggerSummary string
}

// Settings is everything the "My notifications" screen shows.
type Settings struct {
	Consents       []ConsentEntry
	ConsentPending bool
	Rules          []ReachingRule
}

// Preference is a person's channel choice for one rule.
type Preference struct {
	InApp bool
	Email bool
}

// OptionView is an option with its label, as served in the catalog.
type OptionView struct {
	Value string
	Label string
}

// FieldView is a catalog field with its options resolved.
type FieldView struct {
	Field
	Options []OptionView
}

// TriggerView is a visible trigger with its fields resolved.
type TriggerView struct {
	Trigger
	Fields []FieldView
}

// CollectionView is a visible collection with its fields resolved.
type CollectionView struct {
	Collection
	Fields  []FieldView
	Summary []FieldView
}

// CatalogView is the part of the catalog the caller may use.
type CatalogView struct {
	Triggers            []TriggerView
	Collections         []CollectionView
	RecipientFields     []FieldView
	NowFields           []FieldView
	OpenDayFields       []FieldView
	OpenDayPlaceholders []Placeholder
	OpenDayRecipients   []Choice
	Resolutions         []Choice
	Repeats             []Choice
}
