---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: test/videos-read.e2e-spec.ts
---

# GET /videos/:publicId — Read State Test Plan

## Application Overview

`GET /videos/:publicId` is how a client observes the video's lifecycle from the outside. It is the only endpoint that makes the `processing → ready | failed` transition verifiable without reading the database directly, so it is what makes the phase's "automatic processing" capability externally testable. The response shape is state-dependent: duration, metadata and thumbnail URL are null until processing succeeds, and `processing_error` is populated only on failure. The endpoint is owner-only.

## Test Scenarios

### 1. State-dependent response shape

**Setup:** `beforeEach` truncates `videos`, `channels`, `users`; bootstrap the app via `Test.createTestingModule({ imports: [AppModule] })` reproducing `main.ts` global config; register and confirm a user; seed video rows directly in each of the states under test so the read contract is exercised without waiting on the worker.

#### 1.1. returns-core-fields-for-owned-video

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. GET /videos/:publicId de um vídeo do próprio canal, com `Authorization: Bearer <access_token>`
    - expect: status `200`
    - expect: body carries `public_id` matching the path parameter
    - expect: body carries `title` matching the seeded row
    - expect: body carries `status` as one of the five lifecycle values
    - expect: body carries `created_at` parsing as a valid ISO-8601 timestamp

#### 1.2. nulls-processing-outputs-while-processing

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. GET /videos/:publicId de um vídeo semeado em `status = 'processing'`
    - expect: status `200`
    - expect: body `status` equals `"processing"`
    - expect: body `duration_seconds` is null
    - expect: body `metadata` is null
    - expect: body `thumbnail_url` is null

#### 1.3. exposes-metadata-and-servable-thumbnail-when-ready

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. Seed a video in `status = 'ready'` with `duration_seconds`, a populated `metadata` JSONB and a `thumbnail_key` pointing at a real object uploaded to MinIO
  2. GET /videos/:publicId
    - expect: status `200`
    - expect: body `duration_seconds` is a number greater than 0
    - expect: body `metadata` carries `width`, `height`, `video_codec`, `container` and `size_bytes`
    - expect: body `thumbnail_url` is a non-empty string
  3. GET the returned `thumbnail_url` directly
    - expect: status `200`
    - expect: the response `Content-Type` is an image type

#### 1.4. exposes-error-reason-when-failed

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. GET /videos/:publicId de um vídeo semeado em `status = 'failed'` com `processing_error` preenchido
    - expect: status `200`
    - expect: body `status` equals `"failed"`
    - expect: body `processing_error` is a non-empty string
    - expect: body `duration_seconds`, `metadata` and `thumbnail_url` are all null

### 2. Authorization boundary

**Setup:** same as group 1; additionally register a **second** confirmed user with its own channel.

#### 2.1. rejects-read-by-non-owner

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. GET /videos/:publicId de um vídeo do primeiro usuário, usando o access token do **segundo** usuário
    - expect: status `403`
    - expect: body `error` equals `"VIDEO_NOT_OWNED"`
    - expect: the response body leaks no video field — no `title`, no `status`

#### 2.2. returns-404-for-unknown-public-id

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. GET /videos/nonexistent0 com token válido
    - expect: status `404`
    - expect: body `error` equals `"VIDEO_NOT_FOUND"`

#### 2.3. rejects-read-without-access-token

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-04T16:12:00Z

**Steps:**
  1. GET /videos/:publicId **sem** header `Authorization`
    - expect: status `401`
    - expect: the response body carries no video field
