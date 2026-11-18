package engine

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"slices"
	"strings"
	"testing"
)

// withEXIF puts an APP1 segment with a GPS marker text right behind the JPEG start marker.
func withEXIF(t *testing.T, jpegData []byte) []byte {
	t.Helper()
	payload := append([]byte("Exif\x00\x00"), []byte("GPSLatitude=47.0707 secret-camera")...)
	segment := []byte{0xff, 0xe1, 0, 0}
	binary.BigEndian.PutUint16(segment[2:], uint16(len(payload)+2))
	segment = append(segment, payload...)
	return slices.Concat(jpegData[:2], segment, jpegData[2:])
}

// withTextChunk inserts a tEXt chunk before the PNG's IEND chunk.
func withTextChunk(t *testing.T, pngData []byte) []byte {
	t.Helper()
	end := bytes.LastIndex(pngData, []byte("IEND")) - 4
	body := []byte("tEXtComment\x00secret-author")
	chunk := binary.BigEndian.AppendUint32(nil, uint32(len(body)-4))
	chunk = append(chunk, body...)
	chunk = binary.BigEndian.AppendUint32(chunk, crc32.ChecksumIEEE(body))
	return slices.Concat(pngData[:end], chunk, pngData[end:])
}

func TestPrepareAssetStripsMetadata(t *testing.T) {
	tests := map[string][]byte{
		"jpeg": withEXIF(t, testJPEG(t)),
		"png":  withTextChunk(t, testPNG(t, 30, 20)),
	}
	for name, upload := range tests {
		if !bytes.Contains(upload, []byte("secret")) && !bytes.Contains(upload, []byte("GPSLatitude")) {
			t.Fatalf("%s: the test upload carries no metadata", name)
		}
		info, stored, err := PrepareAsset(upload)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if bytes.Contains(stored, []byte("secret")) || bytes.Contains(stored, []byte("GPS")) || bytes.Contains(stored, []byte("Exif")) {
			t.Errorf("%s: metadata survived the re-encoding", name)
		}
		// The stored bytes are a valid image of the same size and type.
		again, err := InspectAsset(stored)
		if err != nil || again != info {
			t.Errorf("%s: stored image %+v %v, want %+v", name, again, err, info)
		}
	}
}

func TestPrepareAssetKeepsSVGAndRejectsInvalid(t *testing.T) {
	info, stored, err := PrepareAsset([]byte(testSVG))
	if err != nil || info.ContentType != ContentTypeSVG || string(stored) != testSVG {
		t.Fatalf("svg %+v %v", info, err)
	}
	if _, _, err := PrepareAsset([]byte("not an image")); errorCode(err) != CodeAssetInvalid {
		t.Errorf("garbage: %v", err)
	}
}

func TestDecodeRequiresCanonicalAssetIDs(t *testing.T) {
	const canonical = "0190f3a2-7b1c-7d2e-8f3a-123456789abc"
	valid := func(block Block) error {
		raw, err := Encode(testDoc(KindWiRef, block))
		if err != nil {
			t.Fatal(err)
		}
		_, err = Decode(raw)
		return err
	}
	if err := valid(Block{ID: "p", Type: BlockPicture, Asset: canonical, W: ptr(10.0), H: ptr(10.0)}); err != nil {
		t.Fatalf("canonical picture: %v", err)
	}
	if err := valid(Block{ID: "g", Type: BlockGraphic, Art: "asset:" + canonical, W: ptr(10.0), H: ptr(10.0)}); err != nil {
		t.Fatalf("canonical graphic: %v", err)
	}
	spellings := []string{
		strings.ToUpper(canonical),
		strings.ReplaceAll(canonical, "-", ""),
		"{" + canonical + "}",
		"urn:uuid:" + canonical,
	}
	for _, spelling := range spellings {
		if err := valid(Block{ID: "p", Type: BlockPicture, Asset: spelling, W: ptr(10.0), H: ptr(10.0)}); err == nil {
			t.Errorf("picture asset %q was accepted", spelling)
		}
		if err := valid(Block{ID: "g", Type: BlockGraphic, Art: "asset:" + spelling, W: ptr(10.0), H: ptr(10.0)}); err == nil {
			t.Errorf("graphic art asset:%q was accepted", spelling)
		}
	}
}

func TestReferencedAssetsListsEachOnce(t *testing.T) {
	const a, b = "0190f3a2-7b1c-7d2e-8f3a-123456789abc", "0190f3a2-7b1c-7d2e-8f3a-123456789abd"
	doc := testDoc(KindWiRef,
		Block{ID: "p1", Type: BlockPicture, Asset: b, W: ptr(10.0), H: ptr(10.0)},
		Block{ID: "box", Type: BlockBox, Blocks: []Block{
			{ID: "p2", Type: BlockPicture, Asset: a, W: ptr(10.0), H: ptr(10.0)},
			{ID: "g", Type: BlockGraphic, Art: "asset:" + a, W: ptr(10.0), H: ptr(10.0)},
			{ID: "l", Type: BlockGraphic, Art: ArtLetterhead, W: ptr(10.0), H: ptr(10.0)},
		}},
	)
	if got := ReferencedAssets(doc); !slices.Equal(got, []string{a, b}) {
		t.Errorf("ReferencedAssets = %v", got)
	}
}
