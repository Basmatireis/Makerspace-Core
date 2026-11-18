package engine

import _ "embed"

// IBM Plex Sans (SIL Open Font License 1.1, see fonts/LICENSE.txt), converted losslessly from the WOFF files of
// @ibm/plex-sans 1.1.0 to TrueType so fpdf can embed it as a UTF-8 font.
var (
	//go:embed fonts/IBMPlexSans-Regular.ttf
	plexRegular []byte
	//go:embed fonts/IBMPlexSans-Medium.ttf
	plexMedium []byte
	//go:embed fonts/IBMPlexSans-SemiBold.ttf
	plexSemiBold []byte
)

const (
	plexFamily       = "plexsans"
	plexMediumFamily = "plexsansmedium"
	helveticaFamily  = "Helvetica"
	// Cap heights as a share of the font size; the form table centres capitals in its rows.
	helveticaCapHeight = 0.716
	plexCapHeight      = 0.698
)

// face is the fpdf family and style of a font and weight; Helvetica has no medium, so 500 reads as regular.
func face(font string, weight int) (family, style string) {
	if font == FontHelvetica {
		if weight >= 600 {
			return helveticaFamily, "B"
		}
		return helveticaFamily, ""
	}
	switch {
	case weight >= 600:
		return plexFamily, "B"
	case weight >= 500:
		return plexMediumFamily, ""
	}
	return plexFamily, ""
}

func capHeight(font string) float64 {
	if font == FontHelvetica {
		return helveticaCapHeight
	}
	return plexCapHeight
}

// ensureFont registers a Plex face on first use; parsing a TrueType file costs time, and most documents use one
// or two faces.
func (r *renderer) ensureFont(family, style string) {
	if family == helveticaFamily {
		return
	}
	key := family + "/" + style
	if r.fonts[key] {
		return
	}
	r.fonts[key] = true
	data := plexRegular
	switch {
	case family == plexMediumFamily:
		data = plexMedium
	case style == "B":
		data = plexSemiBold
	}
	r.pdf.AddUTF8FontFromBytes(family, style, data)
}
