package printerconnector

import (
	"errors"
	"net"
	"os"
	"testing"
	"time"
)

func TestStalledPrinterConnectionFailsInsteadOfHanging(t *testing.T) {
	t.Parallel()
	local, printer := net.Pipe()
	t.Cleanup(func() { _ = local.Close(); _ = printer.Close() })
	conn := idleDeadlineConn{Conn: local, timeout: 50 * time.Millisecond}

	done := make(chan error, 1)
	go func() {
		_, err := conn.Read(make([]byte, 1))
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, os.ErrDeadlineExceeded) {
			t.Fatalf("expected a deadline error, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("read on a silent printer connection never returned")
	}
}

func TestPrinterConnectionKeepsGoingWhileDataFlows(t *testing.T) {
	t.Parallel()
	local, printer := net.Pipe()
	t.Cleanup(func() { _ = local.Close(); _ = printer.Close() })
	conn := idleDeadlineConn{Conn: local, timeout: 80 * time.Millisecond}

	go func() {
		// Each chunk arrives within the idle timeout although the whole
		// transfer takes several times as long.
		for range 6 {
			time.Sleep(30 * time.Millisecond)
			if _, err := printer.Write([]byte("x")); err != nil {
				return
			}
		}
		_ = printer.Close()
	}()
	buffer := make([]byte, 1)
	for range 6 {
		if _, err := conn.Read(buffer); err != nil {
			t.Fatalf("steady transfer was cut off: %v", err)
		}
	}
}
