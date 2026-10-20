package printartifacts

// ParserStatus is how completely an artifact could be parsed.
type ParserStatus string

const (
	ParserComplete ParserStatus = "complete"
	ParserPartial  ParserStatus = "partial"
)

// PreviewRole is what a stored preview image shows.
type PreviewRole string

const (
	PreviewPlate PreviewRole = "plate"
	PreviewOther PreviewRole = "other"
)

// Disposition is whether an upload created a new artifact or matched an existing one.
type Disposition string

const (
	DispositionCreated      Disposition = "created"
	DispositionDeduplicated Disposition = "deduplicated"
)
