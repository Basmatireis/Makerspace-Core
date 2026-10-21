package httpapi

import (
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/localupdater"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
)

func localServiceUpdateDTO(
	requestID uuid.UUID,
	target string,
	requestedAt time.Time,
	status localupdater.RequestState,
	reason *string,
	statusAt time.Time,
) nullable.Nullable[openapi.LocalServiceUpdate] {
	return nullable.NewNullableWithValue(openapi.LocalServiceUpdate{
		RequestId:     requestID,
		TargetVersion: target,
		RequestedAt:   requestedAt,
		Status:        openapi.LocalServiceUpdateStatus(status),
		Reason:        nullableString(reason),
		StatusAt:      statusAt,
	})
}

func updateOfferDTO(request *localupdater.Request) nullable.Nullable[openapi.LocalServiceUpdateOffer] {
	if request == nil {
		return nullable.NewNullNullable[openapi.LocalServiceUpdateOffer]()
	}
	return nullable.NewNullableWithValue(
		openapi.LocalServiceUpdateOffer{RequestId: request.RequestID, Version: request.Version},
	)
}

func updaterReportFrom(value *openapi.LocalServiceUpdaterReport) *localupdater.Report {
	if value == nil {
		return nil
	}
	report := &localupdater.Report{Available: value.Available}
	if value.Result.IsSpecified() && !value.Result.IsNull() {
		result := value.Result.MustGet()
		report.Result = &localupdater.ReportResult{
			RequestID: result.RequestId,
			Status:    localupdater.ResultStatus(result.Status),
			Reason:    nullableStringPointer(result.Reason),
		}
	}
	return report
}
