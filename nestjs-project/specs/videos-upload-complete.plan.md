---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:publicId/complete and DELETE /videos/:publicId/upload — Test Plan

## Application Overview

These two endpoints close the upload handshake. `complete` finalizes the multipart upload with the part/ETag list the client recorded, verifies the stored object's real size against the declared ceiling (because a presigned PUT URL constrains neither size nor type, a lying client can only be caught here), transitions the video to `processing` and enqueues the processing job. `DELETE .../upload` is the abort path: it releases the multipart parts the storage is billing for and returns the video to `draft`. Both are owner-only and both guard on the video being in `uploading`.

## Test Scenarios

### 1. Successful completion

**Setup:** `beforeEach` truncates `videos`, `channels`, `users` and drains the `video-processing` queue; bootstrap the app via `Test.createTestingModule({ imports: [AppModule] })` reproducing `main.ts` global config; register and confirm a user; drive `POST /videos` and PUT every presigned part against the real MinIO so the fixture starts from a genuinely uploaded object.

#### 1.1. completes-and-enqueues-processing-job

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. POST /videos/:publicId/complete com body `{ parts: [{ part_number, etag }, ...] }` usando os ETags retornados pelos PUTs das partes
    - expect: status `200`
    - expect: body carries `public_id` matching the request
    - expect: body carries `status` equal to `"processing"`
  2. Inspect the `video-processing` queue
    - expect: exactly one job is waiting
    - expect: the job payload carries `videoId`, `publicId` and `storageKey` matching the video

#### 1.2. clears-upload-id-and-materializes-object

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. POST /videos/:publicId/complete com as partes corretas
    - expect: status `200`
  2. Query the `videos` row for that `public_id`
    - expect: `upload_id` is null
    - expect: `status` is `'processing'`
  3. HEAD the storage object at `videos/{publicId}/original`
    - expect: the object exists
    - expect: its reported size equals the sum of the uploaded parts

### 2. Guards and rejections

**Setup:** same as group 1; additionally register a **second** confirmed user with its own channel for the ownership probe.

#### 2.1. rejects-completion-by-non-owner

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. POST /videos/:publicId/complete com o access token do **segundo** usuário
    - expect: status `403`
    - expect: body `error` equals `"VIDEO_NOT_OWNED"`
  2. Query the `videos` row
    - expect: `status` is still `'uploading'` — the rejected call changed nothing

#### 2.2. rejects-completion-outside-uploading-state

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. POST /videos/:publicId/complete uma primeira vez com as partes corretas
    - expect: status `200`
  2. POST /videos/:publicId/complete uma segunda vez com o mesmo body
    - expect: status `409`
    - expect: body `error` equals `"VIDEO_INVALID_STATE_TRANSITION"`
  3. Inspect the `video-processing` queue
    - expect: still exactly one job — the rejected retry did not enqueue a duplicate

#### 2.3. rejects-object-exceeding-ceiling-and-deletes-it

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. Initiate an upload declaring a small `size_bytes`, then PUT parts whose combined size exceeds the configured ceiling (the presigned PUT cannot refuse them)
  2. POST /videos/:publicId/complete com os ETags reais
    - expect: status `400`
    - expect: body `error` equals `"VIDEO_SIZE_EXCEEDS_LIMIT"`
  3. HEAD the storage object at `videos/{publicId}/original`
    - expect: the object no longer exists — it was deleted
  4. Query the `videos` row
    - expect: `status` is `'failed'`
  5. Inspect the `video-processing` queue
    - expect: no job was enqueued

#### 2.4. returns-404-for-unknown-public-id

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. POST /videos/nonexistent0/complete com body sintaticamente válido
    - expect: status `404`
    - expect: body `error` equals `"VIDEO_NOT_FOUND"`

### 3. Abort path

**Setup:** same as group 1, stopping after `POST /videos` (at least one part uploaded, upload not completed).

#### 3.1. aborts-upload-and-returns-video-to-draft

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. DELETE /videos/:publicId/upload com o token do dono
    - expect: status `204`
    - expect: response has no body
  2. Query the `videos` row
    - expect: `status` is `'draft'`
    - expect: `upload_id` is null
  3. List in-progress multipart uploads on the bucket
    - expect: the aborted upload no longer appears — the parts were released
