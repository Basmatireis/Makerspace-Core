package storage

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
)

type S3Config struct {
	Endpoint, Region, Bucket, AccessKeyID, SecretAccessKey string
	UsePathStyle, DisableTLS                               bool
}

type S3 struct {
	client *s3.Client
	bucket string
}

func NewS3(ctx context.Context, config S3Config) (*S3, error) {
	options := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(config.Region)}
	if config.AccessKeyID != "" || config.SecretAccessKey != "" {
		options = append(options, awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(config.AccessKeyID, config.SecretAccessKey, "")))
	}
	awsConfig, err := awsconfig.LoadDefaultConfig(ctx, options...)
	if err != nil {
		return nil, fmt.Errorf("load S3 configuration: %w", err)
	}
	client := s3.NewFromConfig(awsConfig, func(options *s3.Options) {
		options.UsePathStyle = config.UsePathStyle
		if config.Endpoint != "" {
			endpoint := config.Endpoint
			if !strings.Contains(endpoint, "://") {
				scheme := "https"
				if config.DisableTLS {
					scheme = "http"
				}
				endpoint = scheme + "://" + endpoint
			}
			options.BaseEndpoint = aws.String(endpoint)
		}
	})
	return &S3{client: client, bucket: config.Bucket}, nil
}

func (s *S3) Put(ctx context.Context, key string, reader io.Reader, metadata Metadata) error {
	if err := ValidateKey(key); err != nil {
		return err
	}
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key), Body: reader,
		ContentLength: aws.Int64(metadata.Size),
		Metadata:      map[string]string{"sha256": SHA256Hex(metadata.SHA256)},
	})
	return err
}

func (s *S3) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	if err := ValidateKey(key); err != nil {
		return nil, err
	}
	result, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if isS3NotFound(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return result.Body, nil
}

func (s *S3) Delete(ctx context.Context, key string) error {
	if err := ValidateKey(key); err != nil {
		return err
	}
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	return err
}

func (s *S3) Metadata(ctx context.Context, key string) (Metadata, error) {
	// verify-files and storage copy rely on actual content integrity. Object
	// metadata is supplied by the uploader and cannot prove the bytes match.
	reader, err := s.Open(ctx, key)
	if err != nil {
		return Metadata{}, err
	}
	defer reader.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, &contextReader{ctx: ctx, reader: reader})
	if err != nil {
		return Metadata{}, err
	}
	var digest [sha256.Size]byte
	copy(digest[:], hash.Sum(nil))
	return Metadata{Size: size, SHA256: digest}, nil
}

func isS3NotFound(err error) bool {
	if err == nil {
		return false
	}
	var apiError smithy.APIError
	return errors.As(err, &apiError) && (apiError.ErrorCode() == "NoSuchKey" || apiError.ErrorCode() == "NotFound")
}
