package mail

// TLSMode is how an SMTP connection is secured.
type TLSMode string

const (
	TLSNone     TLSMode = "none"
	TLSStartTLS TLSMode = "starttls"
	TLSImplicit TLSMode = "tls"
)

func (m TLSMode) valid() bool {
	return m == TLSNone || m == TLSStartTLS || m == TLSImplicit
}
