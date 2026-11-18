// Package engine is the pure PDF template engine: the template document model with its strict decoding, the closed
// expression language and its filters, the data schema of every export, the built-in default templates and the
// renderer that lays a template out with go-pdf/fpdf. It has no database, performs no I/O beyond what the caller
// hands in (assets, logo) and never logs template text, data values or rendered output.
//
// Lengths are millimetres and text sizes points. The renderer works in two passes: the first paginates the body,
// the second draws every page with the page count known.
package engine
