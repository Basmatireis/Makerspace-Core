package engine

import (
	"github.com/boombuler/barcode"
	"github.com/boombuler/barcode/code128"
	"github.com/boombuler/barcode/qr"
)

// QR codes and Code 128 barcodes are drawn as vector modules, so they stay sharp at any print resolution.

const (
	barcodeTextSize = 7.0
	barcodeTextGap  = 0.8
)

var codeInk = rgb{r: 0, g: 0, b: 0}

// qr draws a QR code as a square of the smaller side, anchored top left; an empty value draws nothing.
func (r *renderer) qr(id, value string, x, y, w, h float64) {
	if value == "" {
		return
	}
	code, err := qr.Encode(value, qr.M, qr.Auto)
	if err != nil {
		r.problems.warning(id, "The value is too long for a QR code")
		return
	}
	size := min(w, h)
	r.modules(code, x, y, size, size)
}

// barcode draws a Code 128 barcode over the width, with the value below when showText is on.
func (r *renderer) barcode(b *Block, value string, x, y, w, h float64) {
	if value == "" {
		return
	}
	code, err := code128.Encode(value)
	if err != nil {
		r.problems.warning(b.ID, "The value cannot be written as a Code 128 barcode")
		return
	}
	barsH := h
	showText := b.ShowText == nil || *b.ShowText
	st := tstyle{font: r.doc.Page.Font, weight: 400, size: barcodeTextSize, color: codeInk, lineHeight: 1.2}
	if showText {
		barsH = max(h-st.pitch()-barcodeTextGap, h/2)
	}
	r.modules(code, x, y, w, barsH)
	if showText {
		r.setFont(st)
		r.drawLine(st, value, x, w, 0, "center", st.baseline(y+barsH+barcodeTextGap))
	}
}

// modules fills the dark modules of a code, merging horizontal runs into one rectangle each.
func (r *renderer) modules(code barcode.Barcode, x, y, w, h float64) {
	bounds := code.Bounds()
	cols, rows := bounds.Dx(), bounds.Dy()
	if cols == 0 || rows == 0 {
		return
	}
	mw, mh := w/float64(cols), h/float64(rows)
	r.pdf.SetFillColor(codeInk.r, codeInk.g, codeInk.b)
	for row := range rows {
		for col := 0; col < cols; {
			if !dark(code, bounds.Min.X+col, bounds.Min.Y+row) {
				col++
				continue
			}
			start := col
			for col < cols && dark(code, bounds.Min.X+col, bounds.Min.Y+row) {
				col++
			}
			r.pdf.Rect(x+float64(start)*mw, y+float64(row)*mh, float64(col-start)*mw, mh, "F")
		}
	}
}

func dark(code barcode.Barcode, x, y int) bool {
	red, _, _, _ := code.At(x, y).RGBA()
	return red < 0x8000
}
