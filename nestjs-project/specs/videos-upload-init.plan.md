---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: test/videos-upload-init.e2e-spec.ts
---

# POST /videos — Upload Init Test Plan

## Application Overview

`POST /videos` is the first half of the upload handshake. It does not receive the video file: the client declares the file's title, byte size and MIME type, the API validates that declaration against the admission policy (10 GiB ceiling and a format allowlist), pre-registers the video row, opens a multipart upload in the object storage, and returns presigned `UploadPart` URLs the client then PUTs directly to storage. Nothing about this endpoint touches video bytes — that is the whole point of the design, so the tests assert the handshake contract rather than any transfer.

## Test Scenarios

### 1. Successful initiation

**Setup:** `beforeEach` truncates `videos`, `channels`, `users`; bootstrap the app via `Test.createTestingModule({ imports: [AppModule] })` reproducing `main.ts` global config (ValidationPipe + DomainExceptionFilter + ValidationExceptionFilter); register and confirm a user to obtain an access token and its owning channel.

#### 1.1. returns-presigned-parts-for-valid-declaration

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <access_token>` e body `{ title: "Meu vídeo", size_bytes: 20971520, mime_type: "video/mp4" }`
    - expect: status `201`
    - expect: body carries `public_id` as a non-empty string
    - expect: body carries `status` equal to `"uploading"`
    - expect: body carries a non-empty `upload_id`
    - expect: body carries a numeric `part_size_bytes`
    - expect: body carries `parts` as a non-empty array

#### 1.2. part-entries-are-consecutive-and-signed

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. POST /videos com declaração válida de tamanho que exija múltiplas partes
    - expect: status `201`
    - expect: `parts[i].part_number` sequence starts at 1 and increases by exactly 1 with no gaps
    - expect: every `parts[i].url` is a non-empty string containing a presigned query signature
    - expect: every `parts[i].expires_at` parses as a valid ISO-8601 timestamp in the future
    - expect: `parts.length` equals `ceil(size_bytes / part_size_bytes)`

#### 1.3. persists-draft-row-owned-by-authenticated-channel

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. POST /videos com declaração válida
    - expect: status `201`
  2. Query the `videos` table for the returned `public_id`
    - expect: exactly one row exists
    - expect: the row's `status` is `'uploading'`
    - expect: the row's `channel_id` equals the channel of the authenticated user
    - expect: the row's `storage_key` is populated and the `upload_id` is non-null

#### 1.4. consecutive-inits-get-distinct-public-ids

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. POST /videos duas vezes em sequência com declarações válidas
    - expect: both responses return `201`
    - expect: the two `public_id` values differ
  2. Query the `videos` table
    - expect: two rows exist with distinct `public_id` values

### 2. Admission policy rejection

**Setup:** same as group 1.

#### 2.1. rejects-size-above-ceiling

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. POST /videos com body cujo `size_bytes` é `10737418241` (um byte acima de 10 GiB)
    - expect: status `400`
    - expect: body `error` equals `"VIDEO_SIZE_EXCEEDS_LIMIT"`
    - expect: body matches the inherited envelope shape `{ statusCode, error, message }`
  2. Query the `videos` table
    - expect: no row was created — rejection happens before any storage or DB write

#### 2.2. rejects-mime-type-outside-allowlist

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. POST /videos com body cujo `mime_type` é `"application/x-msdownload"`
    - expect: status `400`
    - expect: body `error` equals `"VIDEO_MIME_TYPE_NOT_ACCEPTED"`
  2. Query the `videos` table
    - expect: no row was created

### 3. Authentication boundary

**Setup:** same as group 1, but the request omits credentials.

#### 3.1. rejects-request-without-access-token

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. POST /videos com body válido e **sem** header `Authorization`
    - expect: status `401`
    - expect: no `public_id` is returned
  2. Query the `videos` table
    - expect: no row was created
