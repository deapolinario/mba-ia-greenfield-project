---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos-delivery.e2e-spec.ts
---

# GET /videos/:publicId/stream and /download — Delivery Test Plan

## Application Overview

These two endpoints deliver the video bytes without the bytes passing through the API. Both authorize the request and then answer `302` with a `Location` pointing at a short-lived presigned GET URL; the storage serves the content and implements HTTP `Range` / `206 Partial Content` natively, which is what satisfies "playback without a full download" for free. `/download` differs only in that its presigned URL carries a `response-content-disposition` override so the browser saves the file. Both are owner-only and both require `status = ready` — in every other state the object is absent, incomplete or unverified.

The authorization granularity is deliberately asserted here: the guard runs on the **issuing** request, not per byte. Once issued, the URL is a bearer token valid until expiry — scenario 3.1 pins that boundary.

## Test Scenarios

### 1. Streaming delivery

**Setup:** `beforeEach` truncates `videos`, `channels`, `users`; bootstrap the app via `Test.createTestingModule({ imports: [AppModule] })` reproducing `main.ts` global config; register and confirm a user; seed a video in `status = 'ready'` whose `storage_key` points at a real multi-megabyte object uploaded to MinIO (a short fixture video).

#### 1.1. redirects-to-presigned-url

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. GET /videos/:publicId/stream com `Authorization: Bearer <access_token>`, sem seguir redirects
    - expect: status `302`
    - expect: the `Location` header is a non-empty absolute URL
    - expect: the response body is empty
    - expect: the `Location` URL carries a presigned query signature

#### 1.2. honours-range-request-with-206

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. GET /videos/:publicId/stream e capturar o `Location`
    - expect: status `302`
  2. GET the captured `Location` com header `Range: bytes=0-1023`
    - expect: status `206`
    - expect: the `Content-Range` header is present and describes the requested interval
    - expect: the returned body length is 1024 bytes — not the whole file
  3. GET the same `Location` without a `Range` header
    - expect: status `200`
    - expect: the returned body length equals the full object size

### 2. Download delivery

**Setup:** same as group 1.

#### 2.1. redirects-with-attachment-disposition

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. GET /videos/:publicId/download, sem seguir redirects
    - expect: status `302`
    - expect: the `Location` header is a non-empty absolute URL
  2. GET the captured `Location`
    - expect: status `200`
    - expect: the `Content-Disposition` response header starts with `attachment`

### 3. Guards, authorization and expiry

**Setup:** same as group 1; additionally register a **second** confirmed user with its own channel, and seed videos in the four non-`ready` states.

#### 3.1. presigned-url-stops-being-accepted-after-ttl

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. Configure `PRESIGN_DOWNLOAD_TTL_SECONDS` to a small value for this test run
  2. GET /videos/:publicId/stream e capturar o `Location`
    - expect: status `302`
  3. GET the captured `Location` imediatamente
    - expect: status `200` — the URL is valid inside its window
  4. Wait past the configured TTL, then GET the same `Location` again
    - expect: status `403` — the storage rejects the expired signature
    - expect: the API was never involved in the rejection; expiry is the only access bound

#### 3.2. rejects-delivery-outside-ready-state

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. GET /videos/:publicId/stream para um vídeo em `draft`
    - expect: status `409`
    - expect: body `error` equals `"VIDEO_NOT_READY"`
  2. Repetir para um vídeo em `uploading`
    - expect: status `409` with `error` `"VIDEO_NOT_READY"`
  3. Repetir para um vídeo em `processing`
    - expect: status `409` with `error` `"VIDEO_NOT_READY"`
  4. Repetir para um vídeo em `failed`
    - expect: status `409` with `error` `"VIDEO_NOT_READY"`
    - expect: no `Location` header is set in any of the four responses

#### 3.3. rejects-delivery-by-non-owner

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. GET /videos/:publicId/stream de um vídeo `ready` do primeiro usuário, usando o token do **segundo** usuário
    - expect: status `403`
    - expect: body `error` equals `"VIDEO_NOT_OWNED"`
    - expect: no `Location` header is set — no presigned URL is ever minted for a non-owner
  2. GET /videos/:publicId/download com o mesmo token
    - expect: status `403` with `error` `"VIDEO_NOT_OWNED"`

#### 3.4. rejects-delivery-without-access-token

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. GET /videos/:publicId/stream **sem** header `Authorization`
    - expect: status `401`
    - expect: no `Location` header is set
  2. GET /videos/:publicId/download **sem** header `Authorization`
    - expect: status `401`
