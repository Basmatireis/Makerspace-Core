package engine

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/xml"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/go-pdf/fpdf"
)

// Asset limits.
const (
	// MaxAssetBytes bounds an uploaded image or SVG.
	MaxAssetBytes = 2 << 20
	// MaxAssetPixels bounds the width and the height of a raster image.
	MaxAssetPixels = 4000
	// maxSVGPaths and maxSVGSegments bound the drawing work of one SVG.
	maxSVGPaths    = 2000
	maxSVGSegments = 100000
)

// Asset content types.
const (
	ContentTypePNG  = "image/png"
	ContentTypeJPEG = "image/jpeg"
	ContentTypeSVG  = "image/svg+xml"
)

// CodeAssetInvalid rejects an upload that is not a PNG, JPEG or usable SVG within the limits.
const CodeAssetInvalid = "pdf_template_asset_invalid"

// Asset is the stored bytes of an uploaded image.
type Asset struct {
	Data []byte
}

// ErrAssetNotFound is returned by an AssetSource for an unknown id.
var ErrAssetNotFound = errors.New("pdf template asset not found")

// AssetSource reads uploaded images by id.
type AssetSource interface {
	Asset(ctx context.Context, id string) (Asset, error)
}

// AssetInfo is what InspectAsset found out about an upload.
type AssetInfo struct {
	ContentType string
	Width       int
	Height      int
}

// InspectAsset sniffs an upload by its content (never by name or declared type): PNG and JPEG up to
// MaxAssetPixels on each side, or an SVG with at least one path. Everything else is a 422.
func InspectAsset(data []byte) (AssetInfo, error) {
	if len(data) > MaxAssetBytes {
		return AssetInfo{}, assetInvalid(fmt.Sprintf("Images may be at most %d MiB", MaxAssetBytes>>20))
	}
	switch sniff(data) {
	case ContentTypePNG, ContentTypeJPEG:
		config, format, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil {
			return AssetInfo{}, assetInvalid("The image cannot be read")
		}
		if config.Width < 1 || config.Height < 1 || config.Width > MaxAssetPixels || config.Height > MaxAssetPixels {
			message := fmt.Sprintf("Images may be at most %d × %d pixels", MaxAssetPixels, MaxAssetPixels)
			return AssetInfo{}, assetInvalid(message)
		}
		contentType := ContentTypePNG
		if format == "jpeg" {
			contentType = ContentTypeJPEG
		}
		return AssetInfo{ContentType: contentType, Width: config.Width, Height: config.Height}, nil
	case ContentTypeSVG:
		svg, err := parseSVG(data)
		if err != nil {
			return AssetInfo{}, assetInvalid("The SVG has no drawable paths")
		}
		return AssetInfo{ContentType: ContentTypeSVG, Width: int(svg.width + 0.5), Height: int(svg.height + 0.5)}, nil
	}
	return AssetInfo{}, assetInvalid("Only PNG, JPEG and SVG images can be used")
}

// jpegQuality is the quality of a re-encoded JPEG upload.
const jpegQuality = 90

// PrepareAsset inspects an upload and returns the bytes to store. A PNG or JPEG is decoded and encoded afresh, so
// nothing but the pixels survives: EXIF data (camera, GPS position, author), text chunks and trailing bytes never
// reach the database or a PDF. A JPEG loses its orientation tag with the rest, and the re-encoding is lossy; a PNG
// becomes an 8-bit RGBA one. An SVG is kept as it is, since only its outlines are ever read. The result is again
// limited to MaxAssetBytes.
func PrepareAsset(data []byte) (AssetInfo, []byte, error) {
	info, err := InspectAsset(data)
	if err != nil {
		return AssetInfo{}, nil, err
	}
	if info.ContentType == ContentTypeSVG {
		return info, data, nil
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return AssetInfo{}, nil, assetInvalid("The image cannot be read")
	}
	var out bytes.Buffer
	if info.ContentType == ContentTypeJPEG {
		err = jpeg.Encode(&out, img, &jpeg.Options{Quality: jpegQuality})
	} else {
		normalized := image.NewNRGBA(img.Bounds())
		draw.Draw(normalized, normalized.Bounds(), img, img.Bounds().Min, draw.Src)
		err = png.Encode(&out, normalized)
	}
	if err != nil {
		return AssetInfo{}, nil, assetInvalid("The image cannot be read")
	}
	if out.Len() > MaxAssetBytes {
		return AssetInfo{}, nil, assetInvalid(fmt.Sprintf("Images may be at most %d MiB", MaxAssetBytes>>20))
	}
	return info, out.Bytes(), nil
}

func assetInvalid(message string) error {
	return apperror.New(http.StatusUnprocessableEntity, CodeAssetInvalid, message)
}

var pngSignature = []byte("\x89PNG\r\n\x1a\n")

func sniff(data []byte) string {
	switch {
	case bytes.HasPrefix(data, pngSignature):
		return ContentTypePNG
	case bytes.HasPrefix(data, []byte{0xff, 0xd8, 0xff}):
		return ContentTypeJPEG
	}
	head := bytes.TrimLeft(bytes.TrimPrefix(data, []byte("\xef\xbb\xbf")), " \t\r\n")
	if !bytes.HasPrefix(head, []byte("<")) {
		return ""
	}
	// An SVG is XML whose root element is svg; parseSVG checks the root, this only routes the upload there.
	if bytes.Contains(head[:min(len(head), 4096)], []byte("<svg")) {
		return ContentTypeSVG
	}
	return ""
}

// vectorArt is a parsed SVG: filled paths in its own coordinate system.
type vectorArt struct {
	minX, minY    float64
	width, height float64
	paths         [][]fpdf.SVGBasicSegmentType
}

// parseSVG keeps only the outline of an SVG: the viewBox (or width and height) and the d attribute of every path
// at any depth. Styles, transforms, text, scripts and references are ignored, so nothing in the file is ever
// executed or fetched. The paths are read by fpdf's SVG path parser; a path it cannot read is skipped.
func parseSVG(data []byte) (vectorArt, error) {
	if len(data) > MaxAssetBytes {
		return vectorArt{}, errors.New("svg too large")
	}
	decoder := xml.NewDecoder(bytes.NewReader(data))
	decoder.Strict = true
	decoder.Entity = map[string]string{}
	var art vectorArt
	var ds []string
	rootSeen := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return vectorArt{}, fmt.Errorf("read svg: %w", err)
		}
		start, ok := token.(xml.StartElement)
		if !ok {
			continue
		}
		if !rootSeen {
			if start.Name.Local != "svg" {
				return vectorArt{}, errors.New("not an svg")
			}
			rootSeen = true
			art = svgViewport(start.Attr)
			continue
		}
		if start.Name.Local == "path" {
			for _, attr := range start.Attr {
				if attr.Name.Local == "d" && attr.Name.Space == "" {
					ds = append(ds, attr.Value)
				}
			}
			if len(ds) > maxSVGPaths {
				return vectorArt{}, errors.New("svg has too many paths")
			}
		}
	}
	if !rootSeen || art.width <= 0 || art.height <= 0 {
		return vectorArt{}, errors.New("svg has no size")
	}
	segments := 0
	for _, d := range ds {
		// Each path is parsed on its own, so one unsupported command only loses that path.
		var doc bytes.Buffer
		fmt.Fprintf(&doc, `<svg width="%s" height="%s"><path d="`, formatBound(art.width), formatBound(art.height))
		_ = xml.EscapeText(&doc, []byte(d))
		doc.WriteString(`"/></svg>`)
		parsed, err := fpdf.SVGBasicParse(doc.Bytes())
		if err != nil {
			continue
		}
		for _, path := range parsed.Segments {
			segments += len(path)
			if segments > maxSVGSegments {
				return vectorArt{}, errors.New("svg is too complex")
			}
			art.paths = append(art.paths, path)
		}
	}
	if len(art.paths) == 0 {
		return vectorArt{}, errors.New("svg has no paths")
	}
	return art, nil
}

func svgViewport(attrs []xml.Attr) vectorArt {
	var art vectorArt
	var width, height float64
	for _, attr := range attrs {
		switch attr.Name.Local {
		case "viewBox":
			fields := strings.FieldsFunc(attr.Value, func(r rune) bool { return r == ' ' || r == ',' })
			if len(fields) == 4 {
				values := make([]float64, 4)
				ok := true
				for i, field := range fields {
					v, err := strconv.ParseFloat(field, 64)
					ok = ok && err == nil
					values[i] = v
				}
				if ok {
					art.minX, art.minY, art.width, art.height = values[0], values[1], values[2], values[3]
				}
			}
		case "width":
			width = svgLength(attr.Value)
		case "height":
			height = svgLength(attr.Value)
		}
	}
	if art.width <= 0 || art.height <= 0 {
		art.width, art.height = width, height
	}
	return art
}

// svgLength reads a number with an optional unit; the unit only matters for the aspect ratio, which it keeps.
func svgLength(value string) float64 {
	value = strings.TrimSpace(value)
	end := len(value)
	for end > 0 && (value[end-1] < '0' || value[end-1] > '9') && value[end-1] != '.' {
		end--
	}
	n, err := strconv.ParseFloat(value[:end], 64)
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

// drawArt fills the paths of a vector graphic into the box, keeping its aspect ratio, anchored top left.
func (r *renderer) drawArt(art vectorArt, x, y, w, h float64, fill rgb) {
	scale := min(w/art.width, h/art.height)
	if scale <= 0 {
		return
	}
	px := func(v float64) float64 { return x + (v-art.minX)*scale }
	py := func(v float64) float64 { return y + (v-art.minY)*scale }
	r.pdf.SetFillColor(fill.r, fill.g, fill.b)
	for _, path := range art.paths {
		var cx, cy float64
		for _, seg := range path {
			a := seg.Arg
			switch seg.Cmd {
			case 'M':
				r.pdf.MoveTo(px(a[0]), py(a[1]))
				cx, cy = a[0], a[1]
			case 'L':
				r.pdf.LineTo(px(a[0]), py(a[1]))
				cx, cy = a[0], a[1]
			case 'H':
				r.pdf.LineTo(px(a[0]), py(cy))
				cx = a[0]
			case 'V':
				r.pdf.LineTo(px(cx), py(a[0]))
				cy = a[0]
			case 'C':
				r.pdf.CurveBezierCubicTo(px(a[0]), py(a[1]), px(a[2]), py(a[3]), px(a[4]), py(a[5]))
				cx, cy = a[4], a[5]
			case 'Q':
				// A quadratic curve is the cubic with control points two thirds towards the quadratic one.
				c1x, c1y := cx+2.0/3.0*(a[0]-cx), cy+2.0/3.0*(a[1]-cy)
				c2x, c2y := a[2]+2.0/3.0*(a[0]-a[2]), a[3]+2.0/3.0*(a[1]-a[3])
				r.pdf.CurveBezierCubicTo(px(c1x), py(c1y), px(c2x), py(c2y), px(a[2]), py(a[3]))
				cx, cy = a[2], a[3]
			case 'Z':
				r.pdf.ClosePath()
			}
		}
		r.pdf.DrawPath("F")
	}
}

// htuLetterhead is the letterhead artwork of the HTU Kassabuch form (logo, triangles and footer text as outlines)
// as filled paths in millimetres on A4: "#rrggbb" sets the colour, M/L/C/Z build a path, F fills it.
//
//go:embed htu_letterhead.txt
var htuLetterheadSource string

// letterheadSize is the extent of the letterhead artwork: the A4 page it was measured on.
var letterheadSize = PageSize{Width: 210, Height: 297}

type pathOp struct {
	op     byte
	values []float64
	color  rgb
}

var letterheadOps = sync.OnceValues(func() ([]pathOp, error) { return parseLetterhead(htuLetterheadSource) })

func parseLetterhead(source string) ([]pathOp, error) {
	arity := map[byte]int{'M': 2, 'L': 2, 'C': 6, 'Z': 0, 'F': 0}
	var ops []pathOp
	for n, line := range strings.Split(strings.TrimSpace(source), "\n") {
		if strings.HasPrefix(line, "#") {
			color, ok := parseHex(line)
			if !ok {
				return nil, fmt.Errorf("letterhead line %d: bad colour", n+1)
			}
			ops = append(ops, pathOp{op: '#', color: color})
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 || len(fields[0]) != 1 {
			return nil, fmt.Errorf("letterhead line %d: no operator", n+1)
		}
		op := fields[0][0]
		want, ok := arity[op]
		if !ok || len(fields)-1 != want {
			return nil, fmt.Errorf("letterhead line %d: bad operator", n+1)
		}
		values := make([]float64, want)
		for i, field := range fields[1:] {
			v, err := strconv.ParseFloat(field, 64)
			if err != nil {
				return nil, fmt.Errorf("letterhead line %d: %w", n+1, err)
			}
			values[i] = v
		}
		ops = append(ops, pathOp{op: op, values: values})
	}
	return ops, nil
}

// drawLetterhead paints the letterhead scaled from A4 into the box.
func (r *renderer) drawLetterhead(x, y, w, h float64) {
	ops, err := letterheadOps()
	if err != nil {
		return
	}
	scale := min(w/letterheadSize.Width, h/letterheadSize.Height)
	if scale <= 0 {
		return
	}
	px := func(v float64) float64 { return x + v*scale }
	py := func(v float64) float64 { return y + v*scale }
	for _, o := range ops {
		v := o.values
		switch o.op {
		case '#':
			r.pdf.SetFillColor(o.color.r, o.color.g, o.color.b)
		case 'M':
			r.pdf.MoveTo(px(v[0]), py(v[1]))
		case 'L':
			r.pdf.LineTo(px(v[0]), py(v[1]))
		case 'C':
			r.pdf.CurveBezierCubicTo(px(v[0]), py(v[1]), px(v[2]), py(v[3]), px(v[4]), py(v[5]))
		case 'Z':
			r.pdf.ClosePath()
		case 'F':
			r.pdf.DrawPath("F")
		}
	}
}

// loadedAsset is an asset prepared for drawing: a registered raster image or vector art.
type loadedAsset struct {
	name          string
	options       fpdf.ImageOptions
	width, height float64
	art           *vectorArt
	failed        string
}

// asset loads an asset once per rendering. Failures become problems; the element then draws a placeholder.
func (r *renderer) asset(id string) *loadedAsset {
	if loaded, ok := r.assets[id]; ok {
		return loaded
	}
	loaded := &loadedAsset{}
	r.assets[id] = loaded
	if r.in.Assets == nil {
		loaded.failed = "Uploaded images are not available here"
		return loaded
	}
	asset, err := r.in.Assets.Asset(r.ctx, id)
	if err != nil {
		loaded.failed = "The image was not found"
		return loaded
	}
	info, err := InspectAsset(asset.Data)
	if err != nil {
		loaded.failed = "The image cannot be used"
		return loaded
	}
	if info.ContentType == ContentTypeSVG {
		art, err := parseSVG(asset.Data)
		if err != nil {
			loaded.failed = "The SVG cannot be used"
			return loaded
		}
		loaded.art = &art
		return loaded
	}
	r.registerImage(loaded, "asset-"+id, asset.Data, info.ContentType)
	return loaded
}

// registerImage hands raster data to fpdf. The image is decoded completely first: fpdf panics on some corrupt
// PNG data and rejects interlaced and 16-bit PNG, so such a PNG is re-encoded as a plain 8-bit one. A failure is a
// problem of the element, never of the document.
func (r *renderer) registerImage(loaded *loadedAsset, name string, data []byte, contentType string) {
	options := fpdf.ImageOptions{ImageType: "PNG"}
	if contentType == ContentTypeJPEG {
		options.ImageType = "JPG"
	}
	unsupported := "The image cannot be read (use a PNG or a JPEG)"
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		loaded.failed = unsupported
		return
	}
	if contentType == ContentTypePNG && pngNeedsNormalizing(data) {
		normalized := image.NewNRGBA(img.Bounds())
		draw.Draw(normalized, normalized.Bounds(), img, img.Bounds().Min, draw.Src)
		var out bytes.Buffer
		if err := png.Encode(&out, normalized); err != nil {
			loaded.failed = unsupported
			return
		}
		data = out.Bytes()
	}
	var info *fpdf.ImageInfoType
	func() {
		defer func() {
			if recover() != nil {
				info = nil
			}
		}()
		info = r.pdf.RegisterImageOptionsReader(name, options, bytes.NewReader(data))
	}()
	if !r.pdf.Ok() || info == nil || info.Width() <= 0 || info.Height() <= 0 {
		r.pdf.ClearError()
		loaded.failed = unsupported
		return
	}
	loaded.name, loaded.options = name, options
	loaded.width, loaded.height = info.Width(), info.Height()
}

// pngNeedsNormalizing reads the PNG header: fpdf embeds only non-interlaced PNG with up to 8 bits per channel.
func pngNeedsNormalizing(data []byte) bool {
	const bitDepthAt, interlaceAt = 24, 28
	if len(data) <= interlaceAt {
		return true
	}
	return data[bitDepthAt] > 8 || data[interlaceAt] != 0
}

// logo loads the branding logo once.
func (r *renderer) logo() *loadedAsset {
	if r.logoAsset != nil {
		return r.logoAsset
	}
	r.logoAsset = &loadedAsset{failed: "No logo"}
	if r.in.Logo == nil || len(r.in.Logo.Data) == 0 || len(r.in.Logo.Data) > MaxAssetBytes {
		return r.logoAsset
	}
	contentType := sniff(r.in.Logo.Data)
	if contentType != ContentTypePNG && contentType != ContentTypeJPEG {
		return r.logoAsset
	}
	loaded := &loadedAsset{}
	r.registerImage(loaded, "logo", r.in.Logo.Data, contentType)
	r.logoAsset = loaded
	return loaded
}

// drawImage places a raster image into the box, keeping its aspect ratio, anchored top left.
func (r *renderer) drawImage(img *loadedAsset, x, y, w, h float64) {
	if img.width <= 0 || img.height <= 0 {
		return
	}
	scale := min(w/img.width, h/img.height)
	r.pdf.ImageOptions(img.name, x, y, img.width*scale, img.height*scale, false, img.options, 0, "")
}
