package mail

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"mime"
	"mime/quotedprintable"
	netmail "net/mail"
	"strings"
)

// renderMIME builds the RFC 5322 message. The plain-text part is always present. An HTML body makes
// it multipart/alternative; attachments wrap everything in multipart/mixed.
func renderMIME(fromName, fromAddress string, message Message) (string, error) {
	if _, err := netmail.ParseAddress(message.To); err != nil || hasHeaderBreak(message.Subject) {
		return "", fmt.Errorf("invalid mail message")
	}
	for _, cc := range message.Cc {
		if parsed, err := netmail.ParseAddress(cc); err != nil || parsed.Address != cc {
			return "", fmt.Errorf("invalid mail message")
		}
	}
	for _, attachment := range message.Attachments {
		if attachment.Name == "" || strings.ContainsAny(attachment.Name, "\r\n\"\\") ||
			hasHeaderBreak(attachment.ContentType) {
			return "", fmt.Errorf("invalid mail attachment")
		}
		if _, _, err := mime.ParseMediaType(attachment.ContentType); err != nil {
			return "", fmt.Errorf("invalid mail attachment")
		}
	}
	from := (&netmail.Address{Name: fromName, Address: fromAddress}).String()
	to := (&netmail.Address{Address: message.To}).String()
	var out bytes.Buffer
	header := func(name, value string) { out.WriteString(name + ": " + value + "\r\n") }
	header("From", from)
	header("To", to)
	if len(message.Cc) > 0 {
		copies := make([]string, len(message.Cc))
		for i, cc := range message.Cc {
			copies[i] = (&netmail.Address{Address: cc}).String()
		}
		header("Cc", strings.Join(copies, ", "))
	}
	header("Subject", mime.QEncoding.Encode("utf-8", message.Subject))
	header("MIME-Version", "1.0")

	hasHTML := message.HTML != ""
	switch {
	case len(message.Attachments) > 0:
		mixed, err := boundary()
		if err != nil {
			return "", err
		}
		header("Content-Type", `multipart/mixed; boundary="`+mixed+`"`)
		out.WriteString("\r\n--" + mixed + "\r\n")
		if err := writeBody(&out, message, hasHTML); err != nil {
			return "", err
		}
		for _, attachment := range message.Attachments {
			out.WriteString("--" + mixed + "\r\n")
			out.WriteString("Content-Type: " + attachment.ContentType + "; name=\"" + encodeFilename(attachment.Name) + "\"\r\n")
			out.WriteString("Content-Transfer-Encoding: base64\r\n")
			out.WriteString("Content-Disposition: attachment; filename=\"" + encodeFilename(attachment.Name) + "\"\r\n\r\n")
			writeBase64(&out, attachment.Data)
		}
		out.WriteString("--" + mixed + "--\r\n")
	default:
		if err := writeBody(&out, message, hasHTML); err != nil {
			return "", err
		}
	}
	return out.String(), nil
}

// writeBody writes the content headers and body: a single text/plain part, or a multipart/alternative.
// When it is nested in multipart/mixed, the caller has already written the boundary line.
func writeBody(out *bytes.Buffer, message Message, hasHTML bool) error {
	if !hasHTML {
		out.WriteString("Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n")
		return writeQP(out, message.Text)
	}
	alt, err := boundary()
	if err != nil {
		return err
	}
	out.WriteString(`Content-Type: multipart/alternative; boundary="` + alt + "\"\r\n\r\n")
	out.WriteString("--" + alt + "\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n")
	if err := writeQP(out, message.Text); err != nil {
		return err
	}
	out.WriteString("\r\n--" + alt + "\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n")
	if err := writeQP(out, message.HTML); err != nil {
		return err
	}
	out.WriteString("\r\n--" + alt + "--\r\n")
	return nil
}

func writeQP(out *bytes.Buffer, text string) error {
	normalized := strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\n", "\r\n")
	writer := quotedprintable.NewWriter(out)
	writer.Binary = false
	if _, err := writer.Write([]byte(normalized)); err != nil {
		return err
	}
	return writer.Close()
}

func writeBase64(out *bytes.Buffer, data []byte) {
	encoded := base64.StdEncoding.EncodeToString(data)
	for len(encoded) > 76 {
		out.WriteString(encoded[:76] + "\r\n")
		encoded = encoded[76:]
	}
	out.WriteString(encoded + "\r\n")
}

func encodeFilename(name string) string { return mime.QEncoding.Encode("utf-8", name) }

func boundary() (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return "=_makerspace_" + hex.EncodeToString(random), nil
}
