package printerconnector

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/textproto"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var passiveResponsePattern = regexp.MustCompile(
	`\(([0-9]{1,3}),([0-9]{1,3}),([0-9]{1,3}),([0-9]{1,3}),([0-9]{1,3}),([0-9]{1,3})\)`,
)

type FTPEntry struct {
	Name    string
	Size    int64
	IsDir   bool
	RawLine string
}

type ArtifactCandidate struct {
	RemotePath string
	Name       string
	Size       int64
}

// SelectArtifactCandidate performs exact matching only. An exact reported path
// wins; otherwise an exact basename must identify one file across /cache and /.
func SelectArtifactCandidate(reportedPath string, listings map[string][]FTPEntry) (ArtifactCandidate, error) {
	reportedPath = strings.TrimSpace(reportedPath)
	hasDirectory := strings.Contains(reportedPath, "/") || strings.Contains(reportedPath, `\`)
	clean := path.Clean("/" + strings.TrimPrefix(strings.ReplaceAll(reportedPath, `\`, "/"), "/"))
	name := path.Base(clean)
	if name == "." || name == "/" || strings.ContainsAny(name, `/\`) {
		return ArtifactCandidate{}, errors.New("invalid reported artifact path")
	}
	if directory := path.Dir(clean); hasDirectory && (directory == "/" || directory == "/cache") {
		for _, entry := range listings[directory] {
			if !entry.IsDir && entry.Name == name {
				return ArtifactCandidate{RemotePath: path.Join(directory, name), Name: name, Size: entry.Size}, nil
			}
		}
	}
	var matches []ArtifactCandidate
	for _, directory := range []string{"/cache", "/"} {
		for _, entry := range listings[directory] {
			if !entry.IsDir && entry.Name == name {
				matches = append(
					matches,
					ArtifactCandidate{RemotePath: path.Join(directory, name), Name: name, Size: entry.Size},
				)
			}
		}
	}
	if len(matches) == 0 {
		return ArtifactCandidate{}, errors.New("reported artifact is not available over FTPS")
	}
	if len(matches) != 1 {
		return ArtifactCandidate{}, errors.New("reported artifact name is ambiguous over FTPS")
	}
	return matches[0], nil
}

type ArtifactCandidateTracker struct {
	lastPath string
	lastSize int64
}

// Observe returns true only after the same positive size is seen in two
// consecutive listings, avoiding retrieval while the printer is still writing.
func (t *ArtifactCandidateTracker) Observe(candidate ArtifactCandidate) bool {
	stable := candidate.Size > 0 && candidate.RemotePath == t.lastPath && candidate.Size == t.lastSize
	t.lastPath, t.lastSize = candidate.RemotePath, candidate.Size
	return stable
}

// BambuFTPSClient is intentionally read-only and implements only the subset
// required to find and retrieve an archive from /cache or /.
type BambuFTPSClient struct {
	settings BambuH2DSettings
	secrets  BambuH2DSecrets
	tls      *tls.Config
	dialer   net.Dialer
	conn     net.Conn
	text     *textproto.Conn
}

func NewBambuFTPSClient(settings BambuH2DSettings, secrets BambuH2DSecrets) (*BambuFTPSClient, error) {
	tlsConfig, err := bambuTLSConfig(settings.SerialNumber)
	if err != nil {
		return nil, err
	}
	return &BambuFTPSClient{
		settings: settings,
		secrets:  secrets,
		tls:      tlsConfig,
		dialer:   net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second},
	}, nil
}

func (c *BambuFTPSClient) Connect(ctx context.Context) error {
	if c.conn != nil {
		return errors.New("Bambu FTPS client is already connected")
	}
	raw, err := c.dialer.DialContext(
		ctx,
		"tcp",
		net.JoinHostPort(c.settings.IPAddress.String(), strconv.Itoa(bambuFTPPort)),
	)
	if err != nil {
		return fmt.Errorf("connect to Bambu FTPS: %w", err)
	}
	tlsConn := tls.Client(raw, c.tls.Clone())
	if err = tlsConn.HandshakeContext(ctx); err != nil {
		_ = raw.Close()
		return fmt.Errorf("negotiate Bambu FTPS control TLS: %w", err)
	}
	c.conn = tlsConn
	c.text = textproto.NewConn(tlsConn)
	if _, _, err = c.text.ReadResponse(220); err != nil {
		_ = c.Close()
		return fmt.Errorf("read Bambu FTPS greeting: %w", err)
	}
	if err = c.login(); err != nil {
		_ = c.Close()
		return err
	}
	return nil
}

func (c *BambuFTPSClient) login() error {
	code, _, err := c.command(-1, "USER %s", "bblp")
	if err != nil {
		return err
	}
	if code == 331 {
		if _, _, err = c.command(230, "PASS %s", c.secrets.LANAccessCode); err != nil {
			return fmt.Errorf("authenticate Bambu FTPS: %w", err)
		}
	} else if code != 230 {
		return fmt.Errorf("authenticate Bambu FTPS: unexpected USER response %d", code)
	}
	for _, command := range []struct {
		code int
		line string
	}{{200, "TYPE I"}, {200, "PBSZ 0"}, {200, "PROT P"}} {
		if _, _, err = c.command(command.code, "%s", command.line); err != nil {
			return fmt.Errorf("initialize Bambu FTPS: %w", err)
		}
	}
	return nil
}

func (c *BambuFTPSClient) Close() error {
	if c.text != nil {
		err := c.text.Close()
		c.text = nil
		c.conn = nil
		return err
	}
	return nil
}

func (c *BambuFTPSClient) command(expect int, format string, args ...any) (int, string, error) {
	if c.text == nil {
		return 0, "", errors.New("Bambu FTPS client is not connected")
	}
	id, err := c.text.Cmd(format, args...)
	if err != nil {
		return 0, "", err
	}
	c.text.StartResponse(id)
	defer c.text.EndResponse(id)
	return c.text.ReadResponse(expect)
}

func (c *BambuFTPSClient) List(ctx context.Context, directory string) ([]FTPEntry, error) {
	if directory != "/" && directory != "/cache" {
		return nil, errors.New("Bambu FTPS listing is restricted to / and /cache")
	}
	var data []byte
	err := c.transfer(ctx, "LIST "+directory, func(reader io.Reader) error {
		var readErr error
		data, readErr = io.ReadAll(io.LimitReader(reader, 4<<20))
		return readErr
	})
	if err != nil {
		return nil, err
	}
	entries, err := parseFTPList(data)
	if err != nil {
		return nil, fmt.Errorf("parse Bambu FTPS listing: %w", err)
	}
	return entries, nil
}

func (c *BambuFTPSClient) Retrieve(ctx context.Context, remotePath string, writer io.Writer) error {
	clean := path.Clean("/" + strings.TrimPrefix(remotePath, "/"))
	directory := path.Dir(clean)
	if (directory != "/" && directory != "/cache") || path.Base(clean) == "." || path.Base(clean) == "/" {
		return errors.New("Bambu FTPS retrieval is restricted to files directly below / or /cache")
	}
	if writer == nil {
		return errors.New("Bambu FTPS retrieval writer is required")
	}
	return c.transfer(ctx, "RETR "+clean, func(reader io.Reader) error {
		_, err := io.Copy(writer, io.LimitReader(reader, maxStagedArtifact+1))
		return err
	})
}

func (c *BambuFTPSClient) transfer(ctx context.Context, command string, consume func(io.Reader) error) error {
	_, response, err := c.command(227, "PASV")
	if err != nil {
		return fmt.Errorf("enter Bambu FTPS passive mode: %w", err)
	}
	port, err := parsePassivePort(response)
	if err != nil {
		return err
	}
	// Ignore the advertised address. Printers commonly return an unusable
	// address and the configured/verified printer IP is the only trusted host.
	raw, err := c.dialer.DialContext(ctx, "tcp", net.JoinHostPort(c.settings.IPAddress.String(), strconv.Itoa(port)))
	if err != nil {
		return fmt.Errorf("connect Bambu FTPS data channel: %w", err)
	}
	defer func() { _ = raw.Close() }()
	id, err := c.text.Cmd("%s", command)
	if err != nil {
		return err
	}
	c.text.StartResponse(id)
	defer c.text.EndResponse(id)
	if _, _, err = c.text.ReadResponse(150); err != nil {
		return fmt.Errorf("start Bambu FTPS transfer: %w", err)
	}
	// Bambu's server expects data-channel TLS only after the preliminary 150.
	data := tls.Client(raw, c.tls.Clone())
	if err = data.HandshakeContext(ctx); err != nil {
		return fmt.Errorf("negotiate Bambu FTPS data TLS: %w", err)
	}
	if err = consume(data); err != nil {
		return err
	}
	if err = data.Close(); err != nil {
		return err
	}
	if _, _, err = c.text.ReadResponse(226); err != nil {
		return fmt.Errorf("finish Bambu FTPS transfer: %w", err)
	}
	return nil
}

func parsePassivePort(response string) (int, error) {
	match := passiveResponsePattern.FindStringSubmatch(response)
	if len(match) != 7 {
		return 0, errors.New("invalid Bambu FTPS PASV response")
	}
	high, highErr := strconv.Atoi(match[5])
	low, lowErr := strconv.Atoi(match[6])
	if highErr != nil || lowErr != nil || high > 255 || low > 255 {
		return 0, errors.New("invalid Bambu FTPS PASV port")
	}
	port := high*256 + low
	if port == 0 {
		return 0, errors.New("invalid Bambu FTPS PASV port")
	}
	return port, nil
}

func parseFTPList(data []byte) ([]FTPEntry, error) {
	if len(data) >= 4<<20 {
		return nil, errors.New("Bambu FTPS listing exceeds 4 MiB")
	}
	var result []FTPEntry
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	scanner.Buffer(make([]byte, 4096), 64<<10)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(strings.ToLower(line), "total ") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 9 {
			return nil, fmt.Errorf("unsupported Bambu FTPS LIST line %q", line)
		}
		size, err := strconv.ParseInt(fields[4], 10, 64)
		if err != nil || size < 0 {
			return nil, fmt.Errorf("invalid Bambu FTPS LIST size in %q", line)
		}
		name := strings.Join(fields[8:], " ")
		if name == "." || name == ".." || strings.ContainsAny(name, `/\`) {
			continue
		}
		result = append(
			result,
			FTPEntry{Name: name, Size: size, IsDir: strings.HasPrefix(fields[0], "d"), RawLine: line},
		)
	}
	return result, scanner.Err()
}
