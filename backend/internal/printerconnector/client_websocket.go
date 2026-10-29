package printerconnector

import (
	"context"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

// websocketURL maps an API path to Core's websocket URL: http becomes ws and https becomes wss, so the
// REST client's rule for plain HTTP (development only) applies unchanged.
func (c *Client) websocketURL(path string) string {
	target := *c.base
	if target.Scheme == "https" {
		target.Scheme = "wss"
	} else {
		target.Scheme = "ws"
	}
	target.Path += "/api/v1" + path
	return target.String()
}

// dialWebsocket opens a websocket to Core with the connector credential. Redirects are not followed.
func (c *Client) dialWebsocket(ctx context.Context, path, token string) (*websocket.Conn, error) {
	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second, Proxy: http.ProxyFromEnvironment}
	conn, response, err := dialer.DialContext(
		ctx,
		c.websocketURL(path),
		http.Header{"Authorization": {"Bearer " + token}},
	)
	if response != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		if response != nil {
			return nil, &CoreError{Status: response.StatusCode, Code: response.Status}
		}
		return nil, err
	}
	return conn, nil
}
