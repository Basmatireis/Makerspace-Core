//go:build pcsc && cgo

package devicebridge

/*
#cgo darwin LDFLAGS: -framework PCSC
#cgo linux pkg-config: libpcsclite
#cgo windows LDFLAGS: -lwinscard
#include <stdint.h>
#include <stdlib.h>
#ifdef _WIN32
#include <windows.h>
#include <winscard.h>
#elif __APPLE__
#include <PCSC/winscard.h>
#else
#include <PCSC/winscard.h>
#endif

long bridge_establish(uintptr_t *result) {
	SCARDCONTEXT context;
	long status = SCardEstablishContext(SCARD_SCOPE_SYSTEM, NULL, NULL, &context);
	if (status == SCARD_S_SUCCESS) *result = (uintptr_t)context;
	return status;
}

void bridge_release(uintptr_t context) {
	SCardReleaseContext((SCARDCONTEXT)context);
}

long bridge_list_readers(uintptr_t context, char *buffer, uint32_t *length) {
	uint32_t size = *length;
	long status = SCardListReaders((SCARDCONTEXT)context, NULL, buffer, &size);
	*length = (uint32_t)size;
	return status;
}

long bridge_read_uid(uintptr_t context, const char *reader, uint8_t *uid, uint32_t *uid_length, uint32_t *protocol_out) {
	SCARDHANDLE card;
	uint32_t protocol = 0;
	long status = SCardConnect((SCARDCONTEXT)context, reader, SCARD_SHARE_SHARED,
		SCARD_PROTOCOL_T0 | SCARD_PROTOCOL_T1, &card, &protocol);
	if (status != SCARD_S_SUCCESS) return status;
	uint8_t command[] = {0xFF, 0xCA, 0x00, 0x00, 0x00};
	uint8_t response[64];
	uint32_t response_length = sizeof(response);
	SCARD_IO_REQUEST send_pci;
	send_pci.dwProtocol = protocol;
	send_pci.cbPciLength = sizeof(SCARD_IO_REQUEST);
	status = SCardTransmit(card, &send_pci, command, sizeof(command), NULL, response, &response_length);
	SCardDisconnect(card, SCARD_LEAVE_CARD);
	if (status != SCARD_S_SUCCESS) return -102;
	if (response_length < 3 || response[response_length - 2] != 0x90 || response[response_length - 1] != 0x00) return -100;
	response_length -= 2;
	if (response_length > *uid_length) return -101;
	for (uint32_t i = 0; i < response_length; i++) uid[i] = response[i];
	*uid_length = (uint32_t)response_length;
	*protocol_out = (uint32_t)protocol;
	return SCARD_S_SUCCESS;
}
*/
import "C"

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"
	"unsafe"
)

type PCSCSource struct {
	mu         sync.RWMutex
	capability Capability
}

func NewPCSCSource() *PCSCSource {
	return &PCSCSource{capability: Capability{ID: "nfc", Available: false, State: "initializing"}}
}

func (source *PCSCSource) Capability() Capability {
	source.mu.RLock()
	defer source.mu.RUnlock()
	return source.capability
}

func (source *PCSCSource) setCapability(value Capability) {
	source.mu.Lock()
	source.capability = value
	source.mu.Unlock()
}

func (source *PCSCSource) Run(ctx context.Context, broker *Broker) {
	var rawContext C.uintptr_t
	if C.bridge_establish(&rawContext) != 0 {
		source.setCapability(Capability{ID: "nfc", Available: false, State: "unavailable", Detail: "PC/SC service is unavailable"})
		_, _ = broker.Publish(RawEvent{Kind: "capability_state", Source: "pcsc", State: "unavailable", ErrorCode: "pcsc_service_unavailable"})
		return
	}
	defer C.bridge_release(rawContext)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	present := map[string]string{}
	knownReaders := map[string]bool{}
	unsupported := map[string]bool{}
	for {
		readers, ok := pcscReaders(rawContext)
		if !ok {
			source.setCapability(Capability{ID: "nfc", Available: false, State: "error", Detail: "Unable to enumerate PC/SC readers"})
		} else if len(readers) == 0 {
			source.setCapability(Capability{ID: "nfc", Available: false, State: "disconnected", Detail: "No PC/SC reader connected"})
		} else {
			source.setCapability(Capability{ID: "nfc", Available: true, State: "ready"})
		}
		currentReaders := map[string]bool{}
		for _, reader := range readers {
			id := pcscReaderID(reader)
			currentReaders[id] = true
			if !knownReaders[id] {
				_, _ = broker.Publish(RawEvent{Kind: "reader_state", Source: "pcsc", ReaderID: id, ReaderName: reader, State: "connected"})
			}
			uid, protocol, connected, supported := pcscUID(rawContext, reader)
			if !connected {
				if present[id] != "" {
					_, _ = broker.Publish(RawEvent{Kind: "nfc_removed", Source: "pcsc", ReaderID: id, ReaderName: reader})
					delete(present, id)
				}
				continue
			}
			if !supported {
				if !unsupported[id] {
					_, _ = broker.Publish(RawEvent{Kind: "capability_state", Source: "pcsc", ReaderID: id, ReaderName: reader, State: "unavailable", ErrorCode: "uid_read_unsupported"})
					unsupported[id] = true
				}
				continue
			}
			delete(unsupported, id)
			if uid != "" && present[id] != uid {
				if present[id] != "" {
					_, _ = broker.Publish(RawEvent{Kind: "nfc_removed", Source: "pcsc", ReaderID: id, ReaderName: reader})
				}
				_, _ = broker.Publish(RawEvent{Kind: "nfc_scan", Source: "pcsc", UID: uid, ReaderID: id, ReaderName: reader, Protocol: protocol})
				present[id] = uid
			}
		}
		for id := range knownReaders {
			if !currentReaders[id] {
				if present[id] != "" {
					_, _ = broker.Publish(RawEvent{Kind: "nfc_removed", Source: "pcsc", ReaderID: id})
				}
				_, _ = broker.Publish(RawEvent{Kind: "reader_state", Source: "pcsc", ReaderID: id, State: "disconnected"})
				delete(present, id)
				delete(unsupported, id)
			}
		}
		knownReaders = currentReaders
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func pcscReaders(context C.uintptr_t) ([]string, bool) {
	var size C.uint32_t
	status := C.bridge_list_readers(context, nil, &size)
	if status != 0 || size == 0 {
		return nil, status == 0
	}
	buffer := C.malloc(C.size_t(size))
	if buffer == nil {
		return nil, false
	}
	defer C.free(buffer)
	if C.bridge_list_readers(context, (*C.char)(buffer), &size) != 0 {
		return nil, false
	}
	bytes := C.GoBytes(buffer, C.int(size))
	result := make([]string, 0)
	start := 0
	for index, value := range bytes {
		if value == 0 {
			if index == start {
				break
			}
			result = append(result, string(bytes[start:index]))
			start = index + 1
		}
	}
	return result, true
}

func pcscUID(context C.uintptr_t, reader string) (uid, protocol string, connected, supported bool) {
	name := C.CString(reader)
	defer C.free(unsafe.Pointer(name))
	buffer := make([]byte, 32)
	size := C.uint32_t(len(buffer))
	var rawProtocol C.uint32_t
	status := C.bridge_read_uid(context, name, (*C.uint8_t)(unsafe.Pointer(&buffer[0])), &size, &rawProtocol)
	if status != 0 {
		return "", "", status == -100 || status == -101 || status == -102, false
	}
	protocol = "unknown"
	if rawProtocol == C.SCARD_PROTOCOL_T0 {
		protocol = "T=0"
	} else if rawProtocol == C.SCARD_PROTOCOL_T1 {
		protocol = "T=1"
	}
	return hex.EncodeToString(buffer[:int(size)]), protocol, true, true
}

func pcscReaderID(name string) string {
	digest := sha256.Sum256([]byte(name))
	return hex.EncodeToString(digest[:8])
}
