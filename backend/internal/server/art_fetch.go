package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"time"

	"rps-strategy/backend/internal/persistence"
)

// Collecting a picture from a URL somebody else chose.
//
// This is the only place this server makes an outbound request to an address a
// stranger picked, so it is the only place with a server-side request forgery
// problem, and everything here exists for that. The shape of the attack is
// simple: "fetch this image" is a way to make a machine inside a network issue
// a GET that the attacker could not issue themselves — at a metadata endpoint,
// at an admin port, at anything that answers only from inside.
//
// The defence that matters is the Control hook on the dialer. It runs after
// resolution and immediately before connect(2), which is the only moment the
// address actually being used is known. Checking the hostname loses to DNS
// rebinding, and so does resolving here and then dialling the name again: the
// name that answered a public address the first time answers 127.0.0.1 the
// second. Every redirect hop dials through this same transport, which is why
// there is no separate per-hop address check.

const (
	// artFetchDeadline covers the whole exchange, body included.
	artFetchDeadline     = 15 * time.Second
	artFetchMaxRedirects = 3
	// artFetchMaxConcurrent bounds how many sockets a stranger can have this
	// server holding open at once. Without it, a handful of hosts that accept a
	// connection and then say nothing is a slowloris pointed at us.
	artFetchMaxConcurrent = 4
)

type artFetcher struct {
	// client is the seam a test reaches through, and on macOS it is the only
	// way to prove anything about outbound HTTPS at all: crypto/x509 reads
	// SSL_CERT_FILE only on unix && !darwin, so a test server's certificate is
	// trusted by that server's own client and by nothing else. Nothing in
	// production sets this.
	client   httpDoer
	inFlight chan struct{}
	// allowTarget decides whether a URL may be fetched at all, and is applied
	// to every redirect hop as well as to the first request. It is a field
	// rather than a direct call so a test can widen it to one host it started
	// itself — httptest listens on loopback with a random port, which the real
	// policy refuses on both counts, and without this seam the body limit, the
	// redirect cap and the header rules could not be exercised at all.
	//
	// Widening it does not widen the address guard: that lives on the dialer
	// and is what TestTheProductionFetcherRefusesLoopback... proves is attached.
	allowTarget func(*url.URL) error
}

func newArtFetcher() *artFetcher {
	dialer := &net.Dialer{
		Timeout:   5 * time.Second,
		KeepAlive: -1,
		Control:   refuseNonPublicAddress,
	}
	fetcher := &artFetcher{
		inFlight:    make(chan struct{}, artFetchMaxConcurrent),
		allowTarget: validateArtURL,
	}
	fetcher.client = &http.Client{
		Timeout: artFetchDeadline,
		// No cookie can ever attach, to this request or to a redirect.
		Jar: nil,
		Transport: &http.Transport{
			DialContext: dialer.DialContext,
			// Explicitly nil, and load-bearing. A proxy would resolve and
			// connect on our behalf, so the dial would go to the proxy and
			// every address check above it would be skipped. Saying so here
			// stops somebody restoring http.DefaultTransport's
			// ProxyFromEnvironment out of tidiness.
			Proxy:             nil,
			DisableKeepAlives: true,
			// So Content-Length means what it says and nothing arrives
			// small and expands.
			DisableCompression:    true,
			ForceAttemptHTTP2:     false,
			TLSHandshakeTimeout:   5 * time.Second,
			ResponseHeaderTimeout: 5 * time.Second,
		},
		CheckRedirect: func(next *http.Request, via []*http.Request) error {
			if len(via) >= artFetchMaxRedirects {
				return errors.New("that URL redirects too many times")
			}
			// A redirect is a new URL somebody else chose, so it gets the same
			// suspicion the first one got.
			if err := fetcher.allowTarget(next.URL); err != nil {
				return err
			}
			next.Header.Del("Authorization")
			next.Header.Del("Cookie")
			return nil
		},
	}
	return fetcher
}

// refuseNonPublicAddress is the dialer's Control hook: the last word on where a
// fetch may connect.
func refuseNonPublicAddress(network, address string, _ syscall.RawConn) error {
	if network != "tcp4" && network != "tcp6" {
		return fmt.Errorf("a picture cannot be fetched over %s", network)
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("unreadable address %q", address)
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return fmt.Errorf("unreadable address %q", address)
	}
	if blockedAddress(ip) {
		return fmt.Errorf("%s is not a public address", ip)
	}
	return nil
}

// refusedBlocks are the ranges Go's own predicates do not cover.
//
// Listed rather than trusted to a helper, because the interesting ones are the
// ones people assume are covered and are not: IsPrivate does *not* include
// carrier-grade NAT, and the tunnelling ranges reach a private v4 address
// through a translator without ever looking private themselves.
var refusedBlocks = mustParseCIDRs(
	"0.0.0.0/8",          // "this network"
	"100.64.0.0/10",      // carrier-grade NAT — reaches carrier infrastructure
	"192.0.0.0/24",       // IETF protocol assignments
	"192.0.2.0/24",       // documentation
	"198.51.100.0/24",    // documentation
	"203.0.113.0/24",     // documentation
	"192.88.99.0/24",     // 6to4 relay anycast
	"198.18.0.0/15",      // benchmarking
	"240.0.0.0/4",        // reserved
	"255.255.255.255/32", // broadcast
	"64:ff9b::/96",       // NAT64
	"64:ff9b:1::/48",     // NAT64 local
	"2002::/16",          // 6to4, embeds a v4 address
	"2001::/32",          // Teredo, embeds a v4 address
	"100::/64",           // discard-only
)

func mustParseCIDRs(blocks ...string) []*net.IPNet {
	parsed := make([]*net.IPNet, 0, len(blocks))
	for _, block := range blocks {
		_, network, err := net.ParseCIDR(block)
		if err != nil {
			panic("art fetch: bad refused block " + block)
		}
		parsed = append(parsed, network)
	}
	return parsed
}

func blockedAddress(ip net.IP) bool {
	// net.IP normalises ::ffff:a.b.c.d, so an IPv4-mapped address has already
	// been asked every IPv4 question below.
	if ip.IsUnspecified() || ip.IsLoopback() || ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() ||
		!ip.IsGlobalUnicast() {
		return true
	}
	for _, block := range refusedBlocks {
		if block.Contains(ip) {
			return true
		}
	}
	return false
}

// validateArtURL is checked before the dial, for the error message and as
// defence in depth. The Control hook remains the authority on the address.
func validateArtURL(target *url.URL) error {
	if target.Scheme != "https" {
		return errors.New("a picture has to come from an https URL")
	}
	if target.User != nil {
		return errors.New("that URL carries a credential; send the picture itself instead")
	}
	host := target.Hostname()
	if host == "" {
		return errors.New("that URL has no host")
	}
	if port := target.Port(); port != "" && port != "443" {
		// Also closes port scanning by response timing.
		return errors.New("a picture has to come from the standard https port")
	}
	lowered := strings.ToLower(strings.TrimSuffix(host, "."))
	if ip := net.ParseIP(lowered); ip != nil {
		if blockedAddress(ip) {
			return fmt.Errorf("%s is not a public address", ip)
		}
		return nil
	}
	if !strings.Contains(lowered, ".") {
		// A single-label name resolves through the host's own search domains,
		// which is a path straight into a private zone.
		return errors.New("that host name is not a public one")
	}
	for _, suffix := range []string{".local", ".internal", ".localhost", ".home.arpa"} {
		if strings.HasSuffix(lowered, suffix) {
			return errors.New("that host name is not a public one")
		}
	}
	return nil
}

// fetch collects a picture, or says why it would not.
//
// Everything it returns is safe to show the person who asked: the errors name
// what is wrong with *their* URL, and never what this server can see.
func (fetcher *artFetcher) fetch(
	ctx context.Context,
	rawURL string,
	limits persistence.ArtLimits,
) ([]byte, error) {
	target, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return nil, errors.New("that is not a URL")
	}
	if err := fetcher.allowTarget(target); err != nil {
		return nil, err
	}

	select {
	case fetcher.inFlight <- struct{}{}:
		defer func() { <-fetcher.inFlight }()
	default:
		return nil, errors.New("too many pictures are being fetched at once; try again shortly")
	}

	ctx, cancel := context.WithTimeout(ctx, artFetchDeadline)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, errors.New("that is not a URL")
	}
	// Nothing from the inbound request is copied — no authorization, no cookie,
	// no forwarded-for. This request is ours, not a relay of somebody's.
	request.Header.Set("Accept", "image/png, image/jpeg")
	request.Header.Set("User-Agent", "rps-strategy-art-fetch/1")

	response, err := fetcher.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("that picture could not be fetched: %w", unwrapFetchError(err))
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
		_ = response.Body.Close()
	}()

	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("that URL answered %d", response.StatusCode)
	}
	if declared := response.Header.Get("Content-Type"); declared != "" {
		mediaType, _, err := mime.ParseMediaType(declared)
		if err == nil && !allowedFetchType(mediaType) {
			// Refused early and by name, because "that is a web page" is a far
			// more useful answer than "that is not a PNG or a JPEG".
			return nil, fmt.Errorf("that URL answered with %s, not a picture", mediaType)
		}
	}
	if response.ContentLength > int64(limits.WireBytes) {
		return nil, fmt.Errorf("that picture is larger than %d bytes", limits.WireBytes)
	}

	raw, err := io.ReadAll(io.LimitReader(response.Body, int64(limits.WireBytes)+1))
	if err != nil {
		return nil, errors.New("that picture could not be read")
	}
	if len(raw) > limits.WireBytes {
		return nil, fmt.Errorf("that picture is larger than %d bytes", limits.WireBytes)
	}
	// The magic bytes are the authority; the header was only ever a hint, and
	// real content hosts mislabel images constantly.
	if !bytes.HasPrefix(raw, []byte("\x89PNG\r\n\x1a\n")) &&
		!bytes.HasPrefix(raw, []byte{0xFF, 0xD8, 0xFF}) {
		return nil, errors.New("what that URL answered with is not a PNG or a JPEG")
	}
	return raw, nil
}

// allowedFetchType lets the two picture types through, plus the two ways a host
// says "bytes, and I would rather not commit".
func allowedFetchType(mediaType string) bool {
	switch mediaType {
	case "image/png", "image/jpeg", "application/octet-stream", "binary/octet-stream":
		return true
	}
	return false
}

// unwrapFetchError keeps the reason a dial was refused, which is ours and worth
// saying, and drops the URL wrapper around it, which just repeats what the
// caller sent.
func unwrapFetchError(err error) error {
	var urlErr *url.Error
	if errors.As(err, &urlErr) && urlErr.Err != nil {
		return urlErr.Err
	}
	return err
}
