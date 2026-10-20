package branding

// AssetMode is where a branding asset comes from.
type AssetMode string

const (
	AssetDefault AssetMode = "default"
	AssetCustom  AssetMode = "custom"
	AssetNone    AssetMode = "none"
)

// LegalMode is whether a legal page is hosted internally or linked externally.
type LegalMode string

const (
	LegalInternal LegalMode = "internal"
	LegalExternal LegalMode = "external"
)

// LegalKind is a legal document of the makerspace.
type LegalKind string

const (
	LegalImprint LegalKind = "imprint"
	LegalPrivacy LegalKind = "privacy"
)
