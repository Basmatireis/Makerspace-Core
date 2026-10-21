package notifications

import (
	"bytes"
	"html/template"
	"math"
	"net/url"
	"regexp"
	"strings"
)

// Branding is what the shared email layout needs. Zero values are valid: the layout omits the logo,
// the legal links and the organization line, and falls back to a neutral brand colour.
type Branding struct {
	ApplicationName  string
	OrganizationName string
	// PrimaryColor is a #rrggbb colour; anything else is replaced by the default.
	PrimaryColor string
	// LogoURL, ImprintURL and PrivacyURL are absolute http(s) URLs.
	LogoURL, ImprintURL, PrivacyURL string
}

// Content is the semantic body of a branded email. Every field is optional except that a message
// should carry at least a heading or a paragraph. All values are treated as plain text and escaped.
type Content struct {
	Heading    string
	Paragraphs []string
	Action     *Action
	// Code is a one-time code shown in a monospace box and repeated in the plain-text part.
	Code string
	// Rows is an optional two-column table of labels and values (for example invoice details).
	Rows     []Row
	Footnote string
}

// Action is the call-to-action button. URL must be an absolute http(s) URL.
type Action struct{ Label, URL string }

// Row is one line of the details table.
type Row struct{ Label, Value string }

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

const defaultBrandColor = "#0f62fe"

type layoutData struct {
	Content
	Branding
	Action            *Action
	Color, ButtonText string
}

var layoutTemplate = template.Must(template.New("layout").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>{{.Heading}}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f4;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#ffffff;border-top:4px solid {{.Color}};font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#161616;">
<tr><td style="padding:24px 32px 8px 32px;">
{{- if .LogoURL}}<img src="{{.LogoURL}}" alt="{{.ApplicationName}}" height="40" style="display:inline-block;height:40px;width:auto;border:0;vertical-align:middle;margin-right:12px;">{{end -}}
<span style="font-size:16px;font-weight:600;vertical-align:middle;color:#161616;">{{.ApplicationName}}</span>
</td></tr>
<tr><td style="padding:16px 32px 8px 32px;">
{{- if .Heading}}<h1 style="margin:0 0 16px 0;font-size:24px;line-height:32px;font-weight:600;color:#161616;">{{.Heading}}</h1>{{end}}
{{- range .Paragraphs}}<p style="margin:0 0 16px 0;font-size:16px;line-height:24px;color:#161616;">{{.}}</p>{{end}}
{{- if .Action}}<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;"><tr><td bgcolor="{{.Color}}" style="background-color:{{.Color}};border-radius:2px;"><a href="{{.Action.URL}}" style="display:inline-block;padding:14px 24px;font-size:16px;font-weight:600;line-height:20px;color:{{.ButtonText}};text-decoration:none;">{{.Action.Label}}</a></td></tr></table>{{end}}
{{- if .Code}}<p style="margin:0 0 8px 0;font-size:14px;line-height:20px;color:#525252;">Your code</p><p style="margin:0 0 24px 0;padding:12px 16px;background-color:#f4f4f4;border:1px solid #e0e0e0;font-family:'SFMono-Regular',Menlo,Consolas,'Courier New',monospace;font-size:24px;line-height:32px;letter-spacing:4px;color:#161616;">{{.Code}}</p>{{end}}
{{- if .Rows}}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;border-top:1px solid #e0e0e0;">{{range .Rows}}<tr><td style="padding:8px 0;border-bottom:1px solid #e0e0e0;font-size:14px;line-height:20px;color:#525252;">{{.Label}}</td><td align="right" style="padding:8px 0;border-bottom:1px solid #e0e0e0;font-size:14px;line-height:20px;color:#161616;">{{.Value}}</td></tr>{{end}}</table>{{end}}
{{- if .Action}}<p style="margin:0 0 16px 0;font-size:13px;line-height:20px;color:#525252;">If the button does not work, copy this link into your browser:<br><a href="{{.Action.URL}}" style="color:{{.Color}};word-break:break-all;">{{.Action.URL}}</a></p>{{end}}
{{- if .Footnote}}<p style="margin:0 0 16px 0;font-size:14px;line-height:20px;color:#525252;">{{.Footnote}}</p>{{end}}
</td></tr>
<tr><td style="padding:16px 32px 24px 32px;border-top:1px solid #e0e0e0;font-size:12px;line-height:18px;color:#6f6f6f;">
{{- if .OrganizationName}}{{.OrganizationName}}<br>{{end -}}
{{- if .ImprintURL}}<a href="{{.ImprintURL}}" style="color:#6f6f6f;">Imprint</a>{{end}}{{if and .ImprintURL .PrivacyURL}} &middot; {{end}}{{if .PrivacyURL}}<a href="{{.PrivacyURL}}" style="color:#6f6f6f;">Privacy policy</a>{{end -}}
</td></tr>
</table></td></tr></table></body></html>
`))

// RenderBranded renders the content into a plain-text part and an HTML part. The HTML is table
// based with inline styles only (no scripts, remote CSS or tracking). All values are escaped.
func RenderBranded(branding Branding, content Content) (text, htmlBody string) {
	branding = sanitizeBranding(branding)
	if content.Action != nil && !safeURL(content.Action.URL) {
		content.Action = nil
	}
	data := layoutData{
		Content: content, Branding: branding, Action: content.Action,
		Color: branding.PrimaryColor, ButtonText: readableTextColor(branding.PrimaryColor),
	}
	var out bytes.Buffer
	if err := layoutTemplate.Execute(&out, data); err != nil {
		// The template is static; failing here is a programming error and the text part still works.
		return renderText(branding, content), ""
	}
	return renderText(branding, content), out.String()
}

func renderText(branding Branding, content Content) string {
	var b strings.Builder
	if content.Heading != "" {
		b.WriteString(content.Heading + "\n\n")
	}
	for _, paragraph := range content.Paragraphs {
		b.WriteString(paragraph + "\n\n")
	}
	if content.Action != nil {
		b.WriteString(content.Action.Label + ": " + content.Action.URL + "\n\n")
	}
	if content.Code != "" {
		b.WriteString("Your code: " + content.Code + "\n\n")
	}
	for _, row := range content.Rows {
		b.WriteString(row.Label + ": " + row.Value + "\n")
	}
	if len(content.Rows) > 0 {
		b.WriteString("\n")
	}
	if content.Footnote != "" {
		b.WriteString(content.Footnote + "\n\n")
	}
	b.WriteString("-- \n" + branding.ApplicationName)
	if branding.OrganizationName != "" {
		b.WriteString(" / " + branding.OrganizationName)
	}
	b.WriteString("\n")
	if branding.ImprintURL != "" {
		b.WriteString("Imprint: " + branding.ImprintURL + "\n")
	}
	if branding.PrivacyURL != "" {
		b.WriteString("Privacy policy: " + branding.PrivacyURL + "\n")
	}
	return b.String()
}

func sanitizeBranding(branding Branding) Branding {
	if strings.TrimSpace(branding.ApplicationName) == "" {
		branding.ApplicationName = "Makerspace"
	}
	if !hexColor.MatchString(branding.PrimaryColor) {
		branding.PrimaryColor = defaultBrandColor
	}
	for _, link := range []*string{&branding.LogoURL, &branding.ImprintURL, &branding.PrivacyURL} {
		if !safeURL(*link) {
			*link = ""
		}
	}
	return branding
}

func safeURL(raw string) bool {
	if raw == "" || strings.ContainsAny(raw, " \r\n\t") {
		return false
	}
	parsed, err := url.Parse(raw)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != ""
}

// readableTextColor picks black or white text for the best contrast against the background colour.
func readableTextColor(background string) string {
	channel := func(hex string) float64 {
		var value int
		for _, r := range hex {
			value *= 16
			switch {
			case r >= '0' && r <= '9':
				value += int(r - '0')
			case r >= 'a' && r <= 'f':
				value += int(r-'a') + 10
			default:
				value += int(r-'A') + 10
			}
		}
		c := float64(value) / 255
		if c <= 0.03928 {
			return c / 12.92
		}
		return math.Pow((c+0.055)/1.055, 2.4)
	}
	luminance := 0.2126*channel(background[1:3]) + 0.7152*channel(background[3:5]) + 0.0722*channel(background[5:7])
	// White text wins when (1.05)/(L+0.05) > (L+0.05)/0.05 is false, i.e. for dark backgrounds.
	if luminance > 0.179 {
		return "#161616"
	}
	return "#ffffff"
}
