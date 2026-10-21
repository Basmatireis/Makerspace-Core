// Package invoicing hands approved external invoice requests to the university accounting office (wiRef): the
// installation-wide delivery settings and templates, the branded mail and the PDF attachment. The orders package
// builds a Document from a forwarded request and calls Deliver after its transaction has committed.
package invoicing
