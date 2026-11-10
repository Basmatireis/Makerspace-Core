package notifyrules

import (
	"regexp"
	"strings"

	"github.com/google/uuid"
)

// PrintPageLinkPrefix starts the application path of a run's print page, a page outside the staff shell that the
// recipient of the run's job opens after signing in.
const PrintPageLinkPrefix = "/prints/"

// PrintPageLink is the application path of a run's print page.
func PrintPageLink(runID uuid.UUID) string {
	return PrintPageLinkPrefix + runID.String()
}

// isPrintPageLink reports whether a notification's link opens a print page.
func isPrintPageLink(link string) bool {
	return strings.HasPrefix(link, PrintPageLinkPrefix)
}

// printPageAddress is the absolute address of a run's print page, as the {printPage} placeholder writes it. Without a
// configured public address it is the application path.
func (d *Dispatcher) printPageAddress(runID uuid.UUID) string {
	return d.publicBaseURL + PrintPageLink(runID)
}

// printPagePattern matches the print page addresses the dispatcher writes into texts.
func (d *Dispatcher) printPagePattern() *regexp.Regexp {
	return regexp.MustCompile(regexp.QuoteMeta(d.publicBaseURL+PrintPageLinkPrefix) +
		`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)
}

// mailWithoutPrintPage is the subject, body and link of a mail for somebody who cannot sign in with a password: a
// print page would only show them a sign-in, so its address is left out of the texts and a print page link is
// dropped. Other links stay.
func (d *Dispatcher) mailWithoutPrintPage(subject, body string, link *string) (string, string, *string) {
	pattern := d.printPagePattern()
	subject = singleLine(pattern.ReplaceAllString(subject, ""))
	body = strings.TrimSpace(pattern.ReplaceAllString(body, ""))
	if link != nil && isPrintPageLink(*link) {
		link = nil
	}
	return subject, body, link
}
