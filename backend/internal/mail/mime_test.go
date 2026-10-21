package mail

import (
	"encoding/base64"
	"io"
	"mime"
	"mime/multipart"
	netmail "net/mail"
	"strings"
	"testing"
)

func parse(t *testing.T, raw string) *netmail.Message {
	t.Helper()
	message, err := netmail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	return message
}

func parts(t *testing.T, message *netmail.Message) (string, []*multipart.Part, [][]byte) {
	t.Helper()
	mediaType, params, err := mime.ParseMediaType(message.Header.Get("Content-Type"))
	if err != nil {
		t.Fatal(err)
	}
	reader := multipart.NewReader(message.Body, params["boundary"])
	var found []*multipart.Part
	var bodies [][]byte
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(part)
		found = append(found, part)
		bodies = append(bodies, body)
	}
	return mediaType, found, bodies
}

func TestRenderPlainTextOnly(t *testing.T) {
	raw, err := renderMIME("Makerspace", "from@example.test", Message{To: "a@example.test", Subject: "Hi", Text: "Grüße\nline"})
	if err != nil {
		t.Fatal(err)
	}
	message := parse(t, raw)
	mediaType, _, _ := mime.ParseMediaType(message.Header.Get("Content-Type"))
	if mediaType != "text/plain" || message.Header.Get("Subject") != "Hi" {
		t.Fatalf("unexpected headers: %v", message.Header)
	}
	if !strings.Contains(raw, "Gr=C3=BC=C3=9Fe") {
		t.Fatalf("expected quoted-printable body: %q", raw)
	}
}

func TestRenderAlternative(t *testing.T) {
	raw, err := renderMIME("Makerspace", "from@example.test", Message{
		To: "a@example.test", Subject: "Prüfung", Text: "plain text", HTML: "<p>Größe</p>",
	})
	if err != nil {
		t.Fatal(err)
	}
	message := parse(t, raw)
	decoded, err := new(mime.WordDecoder).DecodeHeader(message.Header.Get("Subject"))
	if err != nil || decoded != "Prüfung" {
		t.Fatalf("subject = %q (%v)", decoded, err)
	}
	mediaType, found, bodies := parts(t, message)
	if mediaType != "multipart/alternative" || len(found) != 2 {
		t.Fatalf("unexpected structure %s with %d parts", mediaType, len(found))
	}
	if !strings.HasPrefix(found[0].Header.Get("Content-Type"), "text/plain") ||
		!strings.HasPrefix(found[1].Header.Get("Content-Type"), "text/html") {
		t.Fatal("alternative parts must be text/plain then text/html")
	}
	if !strings.Contains(string(bodies[0]), "plain text") || !strings.Contains(string(bodies[1]), "Größe") {
		t.Fatalf("unexpected bodies: %q", bodies)
	}
}

func TestRenderMixedWithAttachment(t *testing.T) {
	pdf := []byte("%PDF-1.4\n" + strings.Repeat("x", 200))
	raw, err := renderMIME("Makerspace", "from@example.test", Message{
		To: "a@example.test", Subject: "Invoice", Text: "see attached", HTML: "<p>see attached</p>",
		Attachments: []Attachment{{Name: "invoice.pdf", ContentType: "application/pdf", Data: pdf}},
	})
	if err != nil {
		t.Fatal(err)
	}
	message := parse(t, raw)
	mediaType, found, bodies := parts(t, message)
	if mediaType != "multipart/mixed" || len(found) != 2 {
		t.Fatalf("unexpected structure %s with %d parts", mediaType, len(found))
	}
	if !strings.HasPrefix(found[0].Header.Get("Content-Type"), "multipart/alternative") {
		t.Fatal("first part must be the alternative body")
	}
	if found[1].FileName() != "invoice.pdf" || !strings.HasPrefix(found[1].Header.Get("Content-Disposition"), "attachment") {
		t.Fatalf("attachment headers wrong: %v", found[1].Header)
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(string(bodies[1]), "\r\n", ""))
	if err != nil || string(decoded) != string(pdf) {
		t.Fatalf("attachment round trip failed: %v", err)
	}
}

func TestRenderRejectsHeaderInjection(t *testing.T) {
	cases := []Message{
		{To: "a@example.test", Subject: "x\r\nBcc: evil@example.test", Text: "t"},
		{To: "Name <a@example.test>", Subject: "x", Text: "t"},
		{To: "a@example.test\r\nBcc: evil@example.test", Subject: "x", Text: "t"},
		{To: "not an address", Subject: "x", Text: "t"},
		{To: "a@example.test", Subject: "x", Text: "t",
			Attachments: []Attachment{{Name: "a.pdf\r\nX: y", ContentType: "application/pdf"}}},
		{To: "a@example.test", Subject: "x", Text: "t",
			Attachments: []Attachment{{Name: "a.pdf", ContentType: "application/pdf\r\nX: y"}}},
	}
	for index, message := range cases {
		if _, err := renderMIME("Makerspace", "from@example.test", message); err == nil {
			t.Fatalf("case %d: expected rejection", index)
		}
	}
}
