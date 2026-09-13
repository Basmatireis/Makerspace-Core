package logging

import (
	"io"
	"log/slog"
)

func New(output io.Writer, environment string) *slog.Logger {
	level := slog.LevelInfo
	if environment == "development" {
		level = slog.LevelDebug
	}
	return slog.New(slog.NewJSONHandler(output, &slog.HandlerOptions{Level: level}))
}
