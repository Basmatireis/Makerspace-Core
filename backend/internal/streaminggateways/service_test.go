package streaminggateways

import (
	"net/url"
	"testing"
)

func TestNormalizePublicHost(t *testing.T) {
	valid := map[string]string{
		"signage-gw.example.org":      "signage-gw.example.org",
		"Signage-GW.Example.org:8443": "signage-gw.example.org:8443",
		"192.168.1.20:8443":           "192.168.1.20:8443",
		"gateway":                     "gateway",
		"  gw.local  ":                "gw.local",
	}
	for input, want := range valid {
		got, err := NormalizePublicHost(input)
		if err != nil || got != want {
			t.Errorf("%q = %q, %v; want %q", input, got, err, want)
		}
	}
	for _, input := range []string{"", "https://gw.example.org", "gw.example.org/path", "user@gw.example.org", "gw.example.org:", "gw.example.org:0", "gw.example.org:65536", "gw.example.org:08443", "gw example.org", "-gw.example.org", "gw..example.org", "[::1]:8443", "::1", "gw.example.org?x=1", "gw.example.org#frag", "gw_underscore.example.org"} {
		if got, err := NormalizePublicHost(input); err == nil {
			t.Errorf("%q accepted as %q", input, got)
		}
	}
}

func TestBuildSourceURLEscapesTheAccessCode(t *testing.T) {
	got := BuildSourceURL("192.168.1.30", "12345678")
	if got != "rtspx://bblp:12345678@192.168.1.30:322/streaming/live/1" {
		t.Fatalf("source = %s", got)
	}
	tricky := BuildSourceURL("10.0.0.5", "a/b:c@d?e#f g")
	parsed, err := url.Parse(tricky)
	if err != nil {
		t.Fatal(err)
	}
	password, _ := parsed.User.Password()
	if parsed.Scheme != "rtspx" || parsed.User.Username() != "bblp" || password != "a/b:c@d?e#f g" || parsed.Host != "10.0.0.5:322" || parsed.Path != "/streaming/live/1" {
		t.Fatalf("round trip failed: %s", tricky)
	}
}
