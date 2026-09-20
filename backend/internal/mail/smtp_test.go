package mail

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestSMTPProviderDeliversThroughInProcessServer(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	delivered := make(chan string, 1)
	serverError := make(chan error, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverError <- acceptErr
			return
		}
		defer connection.Close()
		reader := bufio.NewReader(connection)
		writer := bufio.NewWriter(connection)
		write := func(line string) error {
			if _, err := writer.WriteString(line + "\r\n"); err != nil {
				return err
			}
			return writer.Flush()
		}
		if err := write("220 fake-smtp ESMTP"); err != nil {
			serverError <- err
			return
		}
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				serverError <- err
				return
			}
			command := strings.TrimSpace(line)
			switch {
			case strings.HasPrefix(command, "EHLO "):
				err = write("250-fake-smtp\r\n250 8BITMIME")
			case strings.HasPrefix(command, "MAIL FROM:"), strings.HasPrefix(command, "RCPT TO:"):
				err = write("250 accepted")
			case command == "DATA":
				if err = write("354 send message"); err == nil {
					var body strings.Builder
					for {
						dataLine, readErr := reader.ReadString('\n')
						if readErr != nil {
							err = readErr
							break
						}
						if dataLine == ".\r\n" {
							break
						}
						body.WriteString(dataLine)
					}
					if err == nil {
						delivered <- body.String()
						err = write("250 queued")
					}
				}
			case command == "QUIT":
				_ = write("221 bye")
				return
			default:
				err = fmt.Errorf("unexpected SMTP command %q", command)
			}
			if err != nil {
				serverError <- err
				return
			}
		}
	}()

	port := listener.Addr().(*net.TCPAddr).Port
	provider, err := NewSMTPProvider(SMTPConfig{
		Host: "127.0.0.1", Port: port, TLSMode: "none",
		FromAddress: "makerspace@example.test", FromName: "Makerspace",
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := provider.Send(ctx, Message{To: "member@example.test", Subject: "Security notice", Text: "Your password changed."}); err != nil {
		t.Fatal(err)
	}
	select {
	case message := <-delivered:
		for _, fragment := range []string{"From: \"Makerspace\" <makerspace@example.test>", "To: <member@example.test>", "Subject: Security notice", "Your password changed."} {
			if !strings.Contains(message, fragment) {
				t.Fatalf("delivered message did not contain %s; message=%s", strconv.Quote(fragment), strconv.Quote(message))
			}
		}
	case err := <-serverError:
		t.Fatal(err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}
