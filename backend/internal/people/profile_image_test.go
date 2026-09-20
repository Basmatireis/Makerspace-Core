package people

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func TestNormalizeProfileImageResizesAndReencodesJPEG(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 1200, 600))
	for y := 0; y < 600; y++ {
		for x := 0; x < 1200; x++ {
			source.SetRGBA(x, y, color.RGBA{R: byte(x), G: byte(y), B: 70, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatal(err)
	}
	normalized, err := normalizeProfileImage(bytes.NewReader(encoded.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	configuration, format, err := image.DecodeConfig(bytes.NewReader(normalized))
	if err != nil {
		t.Fatal(err)
	}
	if format != "jpeg" || configuration.Width != 1024 || configuration.Height != 512 {
		t.Fatalf("unexpected normalized image %s %dx%d", format, configuration.Width, configuration.Height)
	}
}

func TestNormalizeProfileImageRejectsInvalidOversizedAndExcessDimensions(t *testing.T) {
	if _, err := normalizeProfileImage(bytes.NewReader([]byte("not an image"))); err == nil {
		t.Fatal("expected malformed image to fail")
	}
	if _, err := normalizeProfileImage(bytes.NewReader(make([]byte, maxProfileImageBytes+1))); err == nil {
		t.Fatal("expected oversized image to fail")
	}
	wide := image.NewRGBA(image.Rect(0, 0, 4097, 1))
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, wide); err != nil {
		t.Fatal(err)
	}
	if _, err := normalizeProfileImage(bytes.NewReader(encoded.Bytes())); err == nil {
		t.Fatal("expected excessive dimensions to fail")
	}
}
