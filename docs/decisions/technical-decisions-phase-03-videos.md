---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-27
scope_description: "Backend foundation for video upload and processing: object storage access, queue technology, 10GB upload protocol, processing worker topology, FFmpeg invocation, unique video URL identifiers, streaming/download delivery, and the video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the video module (upload handshake, status lifecycle, streaming/download endpoints), the object-storage integration, the processing queue, and the FFmpeg worker. All TDs in this document target this subproject.
- `next-frontend/` — **no open decision.** Fase 03's capability bullets in `docs/project-plan.md` contain no UI surface; video pages are introduced in Fase 04 (painel de gerenciamento) and Fase 05 (página de visualização). The Cross-layer TDs below (TD-02, TD-03, TD-09) fix the contracts a future frontend will consume, but no frontend work is planned or decided in this phase.

> **Research tooling note.** `CLAUDE.md` mandates library documentation lookup via the **context7** MCP server. context7 is **not configured** in this repository (`.mcp.json` declares only `postgres`; `.mcp.json.example` declares `postgres` and `figma`). Version, maintenance-status and API facts below were therefore verified against equivalent primary sources — the npm registry (authoritative for published versions, module format, engines and peer ranges) and official vendor documentation — with each claim traceable to the source cited inline. Re-running this research with context7 enabled is advisable before implementation if the pinned versions are expected to drift.

**Environment constraints verified against the running stack** (these bound several options below):

| Fact | Value | Source |
|------|-------|--------|
| Node.js in container | v25.6.0 | `docker compose exec nestjs-api node --version` |
| PostgreSQL | 17.11 | `SHOW server_version` on the `db` service |
| Module format of compiled output | CommonJS | `main`/`__dirname` usage in `src/mail/mail.module.ts`; ts-jest CJS transform |
| Installed `pg` | ^8.20.0 | `nestjs-project/package.json` |
| Existing Compose services | `nestjs-api`, `db`, `mailpit` | `nestjs-project/compose.yaml` |

---

## TD-01: Queue Technology for Background Video Processing

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/project-plan.md` and `docs/diagrams/software-arch.mermaid` both leave the Message Queue container as **"TBD"** — this is the single largest stack decision of the phase. The queue decouples the upload from the FFmpeg processing so the API never blocks, and it must deliver jobs to a worker running in a separate container. Job volume is low (one job per upload, seconds-to-minutes each), but job duration is long, so visibility timeouts, retry semantics and failure surfacing matter far more than throughput.

**Options:**

### Option A: BullMQ 6.x on Redis, via `@nestjs/bullmq`
- `bullmq@6.3.9` with a new `redis` Compose service, wired through the official `@nestjs/bullmq@12.0.0` module (`peerDependencies` accept `@nestjs/core ^10 || ^11 || ^12` and `bullmq ^3–^6`, so NestJS 11 is supported today). Ships CJS (`main: ./dist/cjs/index.js`), so it works with the project's CommonJS build.
- **Pros:** The canonical, fully documented NestJS path (`@InjectQueue`, `@Processor`, `WorkerHost`). Adds a visible `redis` service to `compose.yaml`, satisfying the phase criterion "fila... real subindo no Compose" unambiguously. Mature retry/backoff, delayed jobs, and a large operational track record.
- **Cons:** Introduces Redis as new infrastructure — a second datastore to run, back up and reason about, for what is a low-volume queue. Job state lives outside PostgreSQL, so a job and the `videos` row it mutates cannot share a transaction.

### Option B: BullMQ 6.x on its PostgreSQL backend
- BullMQ v6 introduced an `IQueueBackend` abstraction with an official PostgreSQL backend: `createPostgresBackend` is passed as the final constructor argument to `Queue`/`Worker`/`QueueEvents`, running the identical API on Postgres instead of Redis. It requires PostgreSQL 13+ (14+ recommended) — the stack runs 17.11 — and the already-installed `pg` package. Jobs live in a dedicated schema (default `bullmq`); blocking waits use `LISTEN/NOTIFY`.
- **Pros:** Zero new infrastructure — reuses the existing `db` service. Same BullMQ API and feature set as Option A (retries, priorities, delayed jobs, schedulers, rate limiting, events); state transitions run as SQL functions inside transactions. Matches the Fase 02 precedent of preferring the datastore already in the stack (`phase-02-auth/TD-03`).
- **Cons:** **`@nestjs/bullmq` does not yet ship this** — the request (nestjs/bull issue #2903, opened 2026-09-04) was merged after the current 12.0.0 release (2026-08-27), so the backend must be wired with a hand-written NestJS provider instead of the official decorators. Schema setup requires an explicit `runMigrations()` deployment step. Throughput is ~1.5–2× lower than Redis (~11k vs ~18k jobs/s) — irrelevant at this phase's volume. Adds no new Compose service, which reads less literally against the "fila real subindo no Compose" criterion.

### Option C: pg-boss 12.x
- `pg-boss@12.35.0`, a PostgreSQL-native job queue built on `LISTEN/NOTIFY` and SKIP LOCKED, with its own schema and cron-style scheduling.
- **Pros:** Purpose-built for Postgres-as-a-queue, no new infrastructure, mature and very actively maintained.
- **Cons:** Ships **ESM-only** (`"type": "module"`, no `main`), which clashes with the project's CommonJS build — consumption requires dynamic `import()` or a build-format change. No official NestJS integration (community wrappers only). A second job-queue idiom to learn with no reuse from the wider BullMQ ecosystem.

### Option D: RabbitMQ via `@golevelup/nestjs-rabbitmq` or `@nestjs/microservices`
- A dedicated broker as a Compose service, consumed with AMQP.
- **Pros:** Purpose-built broker with rich routing, dead-letter exchanges and mature long-job/ack semantics. Clearly a "real queue" in the Compose file.
- **Cons:** Heaviest operational footprint of the four for a single job type. Retry/backoff and job-state introspection must be assembled (DLX + TTL) rather than configured. No first-party NestJS queue abstraction comparable to `@nestjs/bullmq`.

**Recommendation:** **Option A (BullMQ on Redis via `@nestjs/bullmq`)** — it is the only option that combines a released, officially supported NestJS integration with an unambiguous "real queue service in Compose", which the phase is explicitly graded on. Option B is technically the more elegant fit for this stack (same API, no new infrastructure, reuses PostgreSQL 17) and becomes the better choice the moment `@nestjs/bullmq` publishes PostgreSQL support — that release is the trigger to revisit. Choosing B today means trading the official decorators for a small hand-rolled provider; that is a defensible trade if avoiding Redis is valued above the wrapper.

**Decision:** A (BullMQ 6 on Redis via @nestjs/bullmq)
**Libraries:** bullmq@^6.3.x, @nestjs/bullmq@^12.0.0, ioredis@^6.0.0

---

## TD-02: Upload Protocol for Files up to 10GB

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The phase requires 10GB uploads that never block the API, and passing the file through the API is an explicit failure condition. A hard platform limit frames the decision: **a single S3 `PUT` accepts at most 5 GB**, while multipart upload covers 5 MB up to 50 TB (AWS S3 user guide, *Uploading objects*). A 10GB file therefore **cannot** be delivered by one presigned `PUT` — any viable option is multipart or chunked by construction. This contract is Cross-layer: the handshake sequence dictates what the future upload UI must implement.

**Options:**

### Option A: Presigned multipart upload, client-orchestrated
- API creates the multipart upload (`CreateMultipartUpload`) and returns presigned `UploadPart` URLs; the client PUTs parts directly to storage in parallel and reports the resulting ETags; the API then calls `CompleteMultipartUpload`.
- **Pros:** Bytes never touch the API — it only signs and finalizes, so memory/CPU stay flat regardless of file size. Native to S3/MinIO with no extra server component. Parallel part upload gives the best throughput, and a failed part is retried individually. Resumability comes free, since already-uploaded parts persist server-side.
- **Cons:** The most client-side logic of the three (part splitting, parallelism, ETag collection, retries). The API needs endpoints for init/sign/complete/abort, plus a policy for abandoned multipart uploads (lifecycle rule or a cleanup job).

### Option B: tus resumable upload protocol (`@tus/server`)
- An open resumable-upload protocol; the client uploads chunks to a tus endpoint that persists them and can forward to S3 via the tus S3 store.
- **Pros:** Purpose-built for large/flaky uploads, with standardized resume semantics and mature client SDKs (Uppy). Uniform behavior across storage backends.
- **Cons:** Introduces a protocol and a server component beyond the S3 API. In the S3-store configuration the bytes still transit the tus server — i.e. the API container — unless it is deployed separately, which is exactly the load the phase forbids. Extra dependency surface for a capability S3 already provides.

### Option C: Stream the file through the API to storage
- The client POSTs to the API, which pipes the request stream into the storage SDK's upload.
- **Pros:** Simplest possible client (one request); all auth and validation happen in one place.
- **Cons:** Puts 10GB of traffic through the API container for the entire upload duration, occupying a connection and memory buffers — directly contradicting "sem travar o sistema" and the phase's explicit automatic-failure condition. No resumability: a dropped connection restarts from zero.

**Recommendation:** **Option A (presigned multipart)** — it is the only option where the 10GB payload never reaches the API, which is the phase's central constraint, and it is native to the S3/MinIO storage already fixed by the project. The extra client-side orchestration is real but bounded, and it buys parallelism and resumability that Option C cannot offer at all.

**Decision:** A (Presigned multipart upload, client-orchestrated)

---

## TD-03: Upload-Completion Signal that Triggers Processing

**Scope:** Cross-layer

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** With direct-to-storage upload (TD-02), the API no longer observes the end of the transfer, yet it must enqueue the processing job exactly when the object is durable. How the backend learns that the upload finished is a separate decision from how the bytes travel, with different failure modes: a client that uploads successfully and then crashes before notifying leaves an orphaned object and a video stuck in a non-terminal state.

**Options:**

### Option A: Explicit client callback endpoint
- The client, after uploading all parts, calls `POST /videos/:id/complete` with the part ETags; the API calls `CompleteMultipartUpload`, flips the status, and enqueues the processing job in the same transaction boundary.
- **Pros:** Fully synchronous and easy to reason about — one request completes the upload, updates the row and enqueues the job, so failures surface directly to the caller. Requires no storage-side configuration, keeping local dev and CI identical to production. The API stays the single writer of video state.
- **Cons:** Depends on a cooperative client: an abandoned upload leaves the video in `uploading` and the parts unreferenced until a reaper job or an S3 lifecycle rule cleans them.

### Option B: Storage bucket event notification (webhook)
- MinIO/S3 is configured to publish `s3:ObjectCreated:CompleteMultipartUpload` events to a webhook endpoint on the API, which enqueues the job. MinIO supports this with prefix/suffix filtering via `mc event add`.
- **Pros:** Authoritative — the trigger fires from the storage layer when the object is actually durable, independent of client behavior. Naturally covers uploads completed by any client.
- **Cons:** Requires bucket-notification configuration as part of environment provisioning (extra Compose/`mc` bootstrap step), adding a failure mode that only appears at integration time. The webhook must be authenticated and idempotent, since delivery is at-least-once. Harder to exercise deterministically in tests than a direct endpoint call.

### Option C: Polling the storage for expected objects
- A scheduled job periodically issues `HeadObject` for videos still in `uploading`.
- **Pros:** No client cooperation and no storage-side configuration.
- **Cons:** Adds latency proportional to the poll interval and constant background load for an event that is naturally push-shaped. Strictly worse than A or B on every axis except configuration.

**Recommendation:** **Option A (explicit completion endpoint)** — it keeps the whole state transition inside one API call that tests can drive end-to-end with the real Compose stack, and it avoids provisioning steps that would differ between local dev and production. Option B is the more robust production posture and the natural hardening step later; the orphan-upload gap that A leaves is addressed by an S3/MinIO lifecycle rule for incomplete multipart uploads rather than by adopting B now.

**Decision:** A (Explicit client callback endpoint)

---

## TD-04: Object Storage Client Library

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage backend itself is **not** an open decision — the project targets S3-compatible storage, run locally as MinIO in Docker. What is open is which client library the API and worker use to presign URLs, run multipart operations and read objects. The choice determines how portable the code is when MinIO is swapped for real S3 in production.

**Options:**

### Option A: AWS SDK v3 — `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`
- The official modular AWS SDK (`3.1141.0`, published 2026-09-25, CJS-compatible), pointed at MinIO via `endpoint` + `forcePathStyle: true`.
- **Pros:** Speaks the S3 API itself, so the same code runs unchanged against MinIO locally and AWS S3 in production — no vendor lock-in, matching the architecture diagram's "S3 or MinIO". First-party presigner covering `PutObject`, `UploadPart` and `GetObject`. Command-per-operation design keeps the bundle small and the API surface explicit.
- **Cons:** More verbose than a convenience wrapper (every call is a Command object). Multipart orchestration is assembled from individual commands unless `@aws-sdk/lib-storage` is added.

### Option B: `minio` JavaScript client
- MinIO's own client (`8.0.7`, published 2026-02-27) with a higher-level API (`presignedPutObject`, `fPutObject`).
- **Pros:** Terser API for common operations; built by the vendor whose server runs locally.
- **Cons:** Couples the codebase to a vendor client rather than the S3 API. Although it can target AWS S3, the migration path is less canonical and the ecosystem/documentation around presigned multipart is thinner than the AWS SDK's.

**Recommendation:** **Option A (AWS SDK v3)** — the phase's storage target is explicitly "MinIO locally, S3 in production", and the AWS SDK is the client that makes that substitution a configuration change (`endpoint`, `forcePathStyle`) rather than a code change. The extra verbosity is a one-time cost in a thin storage service wrapper.

**Decision:** A (AWS SDK v3)
**Libraries:** @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x

---

## TD-05: Bucket and Object Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The key layout is a cross-component contract: the API presigns upload keys, the worker writes the thumbnail next to the source, and the streaming/download endpoints resolve keys back from the `videos` row. All three must agree, and the layout also determines whether videos and thumbnails can carry different access policies.

**Options:**

### Option A: Single bucket, per-video key prefix
- One bucket (e.g. `streamtube`) with keys grouped by video id: `videos/{videoId}/original`, `videos/{videoId}/thumbnail.jpg`.
- **Pros:** One bucket to create and configure in dev, CI and production. Everything belonging to a video shares a prefix, so listing, lifecycle rules and deletion are a single prefix operation. Keys are derivable from the video id, so the row needs to store little.
- **Cons:** Videos and thumbnails share one bucket policy, so differentiated access (e.g. public-read thumbnails, private videos) must be expressed per-object or via prefix-scoped policies rather than per-bucket.

### Option B: Separate buckets for videos and thumbnails
- `streamtube-videos` and `streamtube-thumbnails`, each with its own policy.
- **Pros:** Clean policy separation — thumbnails can be public/CDN-friendly while video objects stay private behind presigned URLs. Distinct lifecycle and storage-class rules per asset type.
- **Cons:** Two buckets to provision and keep in sync across environments. Deleting a video touches two buckets. The policy benefit is not realized in this phase, where both asset types are served through presigned URLs anyway.

**Recommendation:** **Option A (single bucket, per-video prefix)** — with delivery going through presigned URLs for both asset types (TD-09), the per-bucket policy separation that Option B buys is not exercised in this phase, while the per-video prefix directly simplifies cleanup and lifecycle rules. Splitting buckets later is a migration of thumbnail objects only, and thumbnails are regenerable from the source.

**Decision:** A (Single bucket, per-video key prefix)

---

## TD-06: Video Worker Runtime Topology

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The architecture diagram places the Video Worker in its own container. FFmpeg is CPU-saturating and long-running, so where the worker process lives determines whether video processing can starve HTTP request handling. It also determines which Docker image carries the FFmpeg binaries, since the API image has no reason to.

**Options:**

### Option A: Separate container, same codebase, NestJS standalone application context
- A new Compose service built from the same source with FFmpeg installed, whose entrypoint boots a worker-only module via `NestFactory.createApplicationContext()` (no HTTP listener).
- **Pros:** Full reuse of the existing DI container, TypeORM entities, config namespaces and domain services — no duplicated models or connection setup. CPU isolation from the API is real (separate container, independently scalable). One codebase, one test suite, one migration story.
- **Cons:** The image needs FFmpeg while the API image does not, so either both images carry it or the Dockerfile grows a worker-specific stage/target. Module boundaries must be kept honest so the worker does not transitively import HTTP controllers.

### Option B: Separate container, separate mini-project
- A standalone Node/TypeScript service with its own `package.json`, consuming the queue and talking to Postgres directly.
- **Pros:** Minimal runtime surface and a hard boundary — no chance of pulling HTTP concerns into the worker.
- **Cons:** Duplicates entities, migrations awareness, config parsing and storage access, which must then be kept in sync by hand. A second project to lint, test and build for a worker with one job type. Directly contradicts the project principle of reusing established patterns.

### Option C: In-process worker inside the API container
- The BullMQ worker is registered inside the existing API application.
- **Pros:** Zero new services; simplest Compose file and smallest change.
- **Cons:** FFmpeg competes with request handling for CPU in the same container, so a single large transcode degrades API latency — the precise coupling the phase's async architecture exists to prevent. Also fails the phase criterion requiring a worker running in Compose as its own component.

**Recommendation:** **Option A (separate container, shared codebase, standalone context)** — it delivers the CPU isolation the phase requires while reusing the entities, config and services that Fase 02 established, which is the project's stated "continuidade, não retrabalho" principle. Option B's stronger boundary does not justify duplicating the persistence layer for one job type.

**Decision:** A (Separate container, shared codebase, standalone application context)

---

## TD-07: FFmpeg Invocation Approach

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must extract duration/metadata (a `ffprobe` concern) and cut a single frame into a thumbnail (an `ffmpeg` concern). The decision is how Node invokes those binaries, and it is materially constrained by the state of the ecosystem's dominant wrapper.

**Options:**

### Option A: Direct `child_process.spawn` of `ffmpeg` / `ffprobe`
- The worker image installs the system binaries; the code spawns them with explicit argument arrays and parses `ffprobe -print_format json` output.
- **Pros:** No dependency to age out — the contract is the FFmpeg CLI itself, which is what every wrapper ultimately shells out to. `ffprobe`'s JSON output is a stable, documented interface for duration and stream metadata. Full control over arguments, timeouts and process termination, which matters for killing a runaway transcode. Trivially unit-testable behind a thin adapter.
- **Cons:** Argument construction and output parsing are hand-written. Process lifecycle (timeouts, signal handling, stderr capture) must be handled explicitly rather than inherited from a library.

### Option B: `fluent-ffmpeg` wrapper
- The long-standing chainable Node API over the FFmpeg CLI (`2.1.3`, last published 2024-05-19).
- **Pros:** Ergonomic, widely known API with abundant examples; handles argument assembly and event plumbing.
- **Cons:** **Deprecated and archived.** The npm package carries a "Package no longer supported" deprecation notice and the GitHub repository was archived read-only on 2025-05-22, accepting no issues or pull requests. It is reported not to work correctly with recent FFmpeg versions, since it tried to stabilize an API over the shifting FFmpeg CLI. Adopting it in a greenfield project in 2026 is taking on a known-dead dependency.

### Option C: `ffmpeg.wasm`
- FFmpeg compiled to WebAssembly, run in-process.
- **Pros:** No system binary to install; identical behavior across environments.
- **Cons:** Substantially slower than native FFmpeg and memory-bound — unsuitable for multi-gigabyte source files. Designed primarily for browser use.

**Recommendation:** **Option A (direct `spawn`)** — Option B is disqualified by its deprecation and archival rather than by ergonomics, and Option C cannot handle the file sizes this phase targets. Spawning the binaries directly keeps the worker's dependency on FFmpeg exactly where it belongs: the image, not the dependency tree.

**Decision:** A (Direct child_process.spawn of ffmpeg/ffprobe)

---

## TD-08: Unique Video URL Identifier Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unguessable, collision-free public identifier for its URL, distinct from the internal UUID primary key. `docs/project-plan.md` flags this under Pontos de Atenção: "cada vídeo precisa de uma URL curta e única que nunca conflite com outro vídeo". A constraint narrows the field: the project compiles to **CommonJS**, and the popular ID libraries have moved to ESM-only.

**Options:**

### Option A: `crypto.randomBytes` encoded as base64url
- Node's built-in crypto generates N random bytes rendered with `.toString('base64url')` (e.g. 8 bytes → 11 URL-safe characters, matching YouTube's ID length).
- **Pros:** Zero dependencies and no module-format problem — `node:crypto` is CJS-native. Cryptographically secure and unguessable, so IDs do not leak volume or ordering. Length and alphabet are tuned by choosing the byte count; 8 bytes gives 2^64 possibilities, where collision probability stays negligible far beyond this project's scale. A unique constraint on the column makes any collision a detectable, retryable insert error rather than silent corruption.
- **Cons:** A few lines of hand-written code instead of a named library function. The alphabet includes `-` and `_`, which is fine for URLs but worth stating explicitly in the contract.

### Option B: `nanoid`
- The standard short-ID library, used as `nanoid(11)`.
- **Pros:** Purpose-built, well-audited, with a customizable alphabet and a widely cited collision calculator.
- **Cons:** `nanoid@6.0.1` is **ESM-only** (`"type": "module"`, no `main`) and declares `engines.node ^22 || ^24 || >=26`, so a CommonJS build can only reach it through dynamic `import()`. Staying on the legacy `3.3.19` line (which still exposes `require` via `main: index.cjs`) means deliberately pinning an old major to dodge the module format.

### Option C: UUIDv4 as the public identifier
- Reuse a generated UUID in the URL.
- **Pros:** No new generation logic; uniqueness is a solved problem; `crypto.randomUUID()` is built in.
- **Cons:** 36 characters makes for a long, unfriendly URL, working against the plan's explicit "URL curta" requirement. Note `uuid@14.0.2` is likewise ESM-only, though `crypto.randomUUID()` avoids the dependency entirely.

### Option D: `sqids` (encoded sequential id)
- Encode the row's sequential id into a short string.
- **Pros:** Guaranteed collision-free by construction, since it is a reversible encoding of a unique integer. Very short output.
- **Cons:** Reversible by design, so the ID leaks the row's ordinal — total video count and publication order become public, and IDs become enumerable. `sqids@0.3.0` was last published 2023-09-08. The project's entities use UUID primary keys, so there is no sequential integer to encode without adding one.

**Recommendation:** **Option A (`crypto.randomBytes` + base64url)** — it sidesteps the ESM/CJS friction that affects every library candidate, adds no dependency, and produces exactly the short unguessable token the plan asks for. Option D is disqualified less by its staleness than by enumerability: a public video platform should not expose its catalogue size and ordering through its URLs.

**Decision:** A (crypto.randomBytes + base64url)

---

## TD-09: Streaming and Download Delivery Strategy

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file, which in HTTP terms means honoring `Range` requests with `206 Partial Content` — the mechanism a `<video>` element uses to seek. Download is the same byte-delivery problem with different response headers (`Content-Disposition: attachment`). The decision is who serves those bytes, and it is Cross-layer because it determines what URL a future player points at and whether auth can be enforced per request.

**Options:**

### Option A: API issues a short-lived presigned GET; storage serves the bytes
- The playback/download endpoints authorize the request, then redirect (302) to a presigned S3/MinIO URL, optionally with a response-header override for the download variant.
- **Pros:** Range/`206` handling comes from S3/MinIO natively — no byte-range parsing to implement or get wrong. The video payload never transits the API, so streaming many concurrent viewers does not consume API connections or bandwidth, consistent with the architecture diagram's direct Frontend → Object Storage stream. Short URL expiry keeps access bounded, and authorization still happens on the API hop that issues the URL.
- **Cons:** Once issued, the URL is valid for its lifetime and shareable, so per-request revocation is not possible within that window. The storage endpoint must be reachable from the browser, which requires MinIO to be addressable outside the Compose network in local dev.

### Option B: API proxies the bytes with its own Range handling
- The endpoints parse the `Range` header, fetch the corresponding byte range from storage and stream it back with `206`.
- **Pros:** Every byte is served behind the API's auth, so access can be revoked instantly and per request. The storage service need not be publicly reachable. URLs are stable and not time-limited.
- **Cons:** Every viewer's traffic flows through the API container for the duration of playback, reproducing at read time exactly the bottleneck TD-02 removes at write time. Range parsing, `206`/`416` semantics and backpressure become the project's code to maintain and test.

### Option C: Public bucket with direct URLs
- Objects are world-readable and the video row stores the public URL.
- **Pros:** Simplest possible delivery, trivially cacheable by a CDN.
- **Cons:** No authorization at all, which forecloses the unlisted/private visibility that Fase 04 introduces. A leaked key is permanently public.

**Recommendation:** **Option A (presigned GET redirect)** — it is the only option that both satisfies "sem necessidade de download completo" for free (S3/MinIO implement Range natively) and keeps video bytes off the API, matching the `Frontend → Object Storage: Streams` edge already drawn in the architecture diagram. Option B's per-request revocation is a real advantage, but paying for it with all playback traffic through the API contradicts the phase's core performance constraint; short presign expiry is the proportionate mitigation.

**Decision:** A (Short-lived presigned GET redirect)

---

## TD-10: Video Status Lifecycle and Processing-Failure Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The phase requires the video row to exist as a draft the moment the upload starts, and requires the status to reflect processing outcomes — including failures. The state set is a cross-component contract: the API writes the initial state and the terminal states of the upload handshake, the worker writes the processing outcomes, and listing/playback endpoints filter on it. The phase brief explicitly asks what happens when processing fails.

**Options:**

### Option A: Five states — `draft` → `uploading` → `processing` → `ready` | `failed`
- `draft` on pre-registration, `uploading` once the multipart upload is initiated, `processing` when the job is enqueued, then `ready` or `failed`. The queue retries the job with exponential backoff up to a bounded attempt count; only after the final attempt does the row become `failed`, with the error recorded.
- **Pros:** Distinguishes "created but no bytes yet" from "bytes in flight", which is what makes abandoned-upload cleanup targetable (reap `uploading` rows older than N hours) without touching legitimate drafts. `failed` is terminal and explicit, so the UI and the API can surface the error rather than leaving the video indefinitely in `processing`. Retries are the queue's native concern (TD-01), so the state machine only records the terminal outcome.
- **Cons:** Five states is the largest set of the three, and `draft` vs `uploading` is a distinction the client must drive correctly.

### Option B: Four states — `draft` → `processing` → `ready` | `failed`
- Pre-registration creates `draft`; the completion callback moves straight to `processing`.
- **Pros:** Fewer transitions and less client responsibility. Still satisfies the literal capability wording ("rascunho" → processing → ready/error).
- **Cons:** `draft` conflates "never uploaded" with "upload in progress", so a cleanup job cannot distinguish an abandoned transfer from a video the user intends to finish later — and Fase 04's draft/publish flow will reuse `draft` for exactly that second meaning.

### Option C: Status column plus separate processing-attempt columns
- A minimal status enum alongside `processing_attempts` and `processing_error` columns managed by the worker.
- **Pros:** Retry history is queryable from the database, useful for diagnosing systematic failures.
- **Cons:** Duplicates bookkeeping the queue already maintains (BullMQ tracks attempts and failure reasons per job), creating two sources of truth that can disagree. Attempt counting belongs to the queue layer.

**Recommendation:** **Option A (five states, retries owned by the queue)** — the `draft`/`uploading` split is what keeps abandoned-upload cleanup from colliding with Fase 04's draft/publish semantics, and it costs one extra transition in the handshake the client already performs. Recording only the terminal error on the row (rather than mirroring attempt counts, as in Option C) keeps the queue as the single owner of retry state.

**Decision:** A (Five states, retries owned by the queue)

---

## TD-11: Access Policy for Video Upload, Streaming and Download

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Every endpoint this phase introduces needs an authorization rule, and `/plan-build` is required to emit an Authorization Matrix — without a decision here that matrix would be invented. TD-09 settles *how* bytes are delivered and notes that authorization happens on the API hop that issues the URL, but not *who* is authorized. The question is genuinely open because Fase 03 produces only drafts: the rascunho → publicação flow and the público/unlisted visibility arrive in Fase 04, and the anonymous watching page arrives in Fase 05, while `docs/project-plan.md` lists anonymous access as a platform-level characteristic. The decision must also state what happens when a video is not yet `ready`, since the object may be absent or unprocessed.

**Options:**

### Option A: Owner-only for every operation in this phase
- Upload init/complete, streaming and download all require a valid access token and are restricted to the user who owns the video's channel. A video in `draft`/`uploading`/`processing` is not deliverable at all (404 to non-owners, 409 to the owner).
- **Pros:** Matches the phase's actual domain state — nothing is published yet, so public reads have no meaning. The access change in Fase 04 is a **loosening** (add público/unlisted), which cannot accidentally expose content; tightening later could. Smallest Authorization Matrix, fully exercisable by E2E tests with one authenticated user.
- **Cons:** The streaming/download deliverable can only be demonstrated as the owner, not as an anonymous viewer.

### Option B: Owner-only writes, authenticated reads
- Upload remains owner-only; streaming and download of a `ready` video are allowed to any authenticated user.
- **Pros:** Exercises the delivery path with a second identity, closer to a multi-user platform. Still keeps unprocessed videos private.
- **Cons:** Grants every registered user access to every other user's unpublished drafts — a privacy regression that Fase 04's visibility model would then have to retract.

### Option C: Owner-only writes, anonymous reads for `ready` videos
- Upload remains owner-only; streaming and download of a `ready` video are public, requiring no token.
- **Pros:** Realizes the platform's eventual anonymous-watching behavior now, so Fase 05 inherits a working public path with no change.
- **Cons:** Publishes content that was never published — in Fase 03 `ready` means "processed", not "public". Fase 04 would have to *remove* access when it introduces unlisted/público, which is the risky direction of change.

**Recommendation:** **Option A (owner-only)** — in this phase `ready` means "processed", not "published", so A is the only option whose authorization semantics match the domain state the phase actually produces; it also makes the Fase 04 change a loosening rather than a retraction, which is the safer direction when the asset is user-uploaded content. The lost demonstration of anonymous playback is recovered in Fase 05, which owns that capability.

**Decision:** A (Owner-only for every operation in this phase)

---

## TD-12: Upload Admission Policy — Accepted Formats and Size Enforcement Point

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The 10GB ceiling and "video files only" are stated as scope, but nothing decides where they are *enforced* — and under the recommended presigned-multipart protocol (TD-02) that is a real architectural choice rather than a detail, because the API never sees the bytes. A verified platform constraint narrows the field: a presigned **PUT** URL signs only the bucket, key and expiry, so it constrains neither object size nor content type — a client given a part URL can send far more than it declared. The `content-length-range` policy condition that *would* enforce this server-side exists only for presigned **POST** (single-object form upload) and does not apply to multipart `UploadPart`. Enforcement therefore has to be application-level, and the choice of where determines what an adversarial client can achieve. This is Cross-layer because the accepted-format list and the declared-size field are part of the upload handshake the future client must satisfy.

**Options:**

### Option A: Validate declared metadata at init, verify after completion
- The init request carries filename, MIME type and byte size; the API rejects anything outside the format allowlist or above 10GB before issuing any URL. At completion the API calls `HeadObject` and rejects (and deletes) an object whose real size exceeds the cap; the worker then re-verifies the actual container/codec with `ffprobe` and marks the video `failed` on mismatch.
- **Pros:** Fails fast and free on the common case — an honest client picking the wrong file never uploads a byte. The completion check plus `ffprobe` close the loop against a client that lies, so a false declaration costs storage only until completion. Reuses the `ffprobe` call the worker already makes.
- **Cons:** A lying client can still push bytes into storage before the completion check rejects them. Validation lives in three places (init, complete, worker) and must stay consistent.

### Option B: Option A plus bounded part issuance
- In addition to A, each `UploadPart` URL is signed with a fixed `Content-Length` and the API issues exactly `ceil(declared_size / part_size)` URLs, bounding the theoretical maximum to `N × part_size`.
- **Pros:** Converts the cap from a post-hoc check into a structural bound — the client cannot exceed the issued part budget, closing the window A leaves open.
- **Cons:** Pins the part layout at init, so a client that wants different part sizes or needs to retry with a different split must re-initiate. More signing logic and a stricter contract for the future upload client.

### Option C: Optimistic — worker-only verification
- Any init is accepted; the worker inspects the finished object with `ffprobe` and marks the video `failed` if it is not a supported video or breaches the limits.
- **Pros:** Simplest API surface — no declared-metadata contract, one enforcement point, and the check is authoritative because it inspects real bytes.
- **Cons:** Pays full upload bandwidth, storage and a worker slot for every rejected file, including obvious non-videos. The user only learns the upload was invalid after processing, which is the worst feedback latency of the three.

**Recommendation:** **Option A** — it rejects the overwhelmingly common failure (honest client, wrong file) before any transfer, while the completion-time `HeadObject` and the worker's existing `ffprobe` pass cover the dishonest case without the handshake rigidity Option B imposes on a client that does not exist yet. Option B is the right hardening step if abuse is ever observed, and it layers on top of A without changing the decision; Option C alone makes every bad upload cost a full 10GB transfer.

**Decision:** A (Validate declared metadata at init, verify after completion)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Queue Technology for Background Video Processing | A (BullMQ on Redis via `@nestjs/bullmq`) | A (BullMQ 6 on Redis via @nestjs/bullmq) |
| TD-02 | Cross-layer | Upload Protocol for Files up to 10GB | A (Presigned multipart, client-orchestrated) | A (Presigned multipart upload, client-orchestrated) |
| TD-03 | Cross-layer | Upload-Completion Signal that Triggers Processing | A (Explicit client callback endpoint) | A (Explicit client callback endpoint) |
| TD-04 | Backend | Object Storage Client Library | A (AWS SDK v3 + s3-request-presigner) | A (AWS SDK v3) |
| TD-05 | Backend | Bucket and Object Key Layout | A (Single bucket, per-video key prefix) | A (Single bucket, per-video key prefix) |
| TD-06 | Backend | Video Worker Runtime Topology | A (Separate container, shared codebase, standalone context) | A (Separate container, shared codebase, standalone application context) |
| TD-07 | Backend | FFmpeg Invocation Approach | A (Direct `child_process.spawn` of ffmpeg/ffprobe) | A (Direct child_process.spawn of ffmpeg/ffprobe) |
| TD-08 | Backend | Unique Video URL Identifier Strategy | A (`crypto.randomBytes` + base64url) | A (crypto.randomBytes + base64url) |
| TD-09 | Cross-layer | Streaming and Download Delivery Strategy | A (Short-lived presigned GET redirect) | A (Short-lived presigned GET redirect) |
| TD-10 | Backend | Video Status Lifecycle and Processing-Failure Policy | A (Five states, retries owned by the queue) | A (Five states, retries owned by the queue) |
| TD-11 | Backend | Access Policy for Video Upload, Streaming and Download | A (Owner-only for every operation in this phase) | A (Owner-only for every operation in this phase) |
| TD-12 | Cross-layer | Upload Admission Policy — Accepted Formats and Size Enforcement Point | A (Validate declared metadata at init, verify after completion) | A (Validate declared metadata at init, verify after completion) |

## Sources

Primary sources consulted during this research (context7 unavailable — see the research tooling note above):

- [AWS S3 User Guide — Uploading objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html) — single-PUT 5 GB limit; multipart 5 MB–50 TB
- [BullMQ — PostgreSQL backend](https://docs.bullmq.io/guide/postgresql) — `createPostgresBackend`, PG 13+/14+, `runMigrations()`, throughput comparison
- [BullMQ changelog](https://docs.bullmq.io/changelog) and [releases](https://github.com/taskforcesh/bullmq/releases) — v6 `IQueueBackend` abstraction
- [nestjs/bull issue #2903 — BullMQ PostgreSQL Backend Support](https://github.com/nestjs/bull/issues/2903) — opened 2026-09-04, merged after the 12.0.0 release
- [fluent-ffmpeg on npm](https://www.npmjs.com/package/fluent-ffmpeg) and [issue #1324 — Phasing out fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg/issues/1324) — deprecation and 2025-05-22 archival
- [MinIO — Bucket Notifications](https://docs.min.io/aistor/administration/bucket-notifications/) and [Publish Events to Webhook](https://min.io/docs/minio/linux/administration/monitoring/publish-events-to-webhook.html) — `s3:ObjectCreated:CompleteMultipartUpload`, `mc event add`
- [AWS S3 User Guide — Download and upload objects with presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) — what a presigned URL actually signs (bucket, key, method, expiry) and the documented ways to limit its capabilities (TD-12)
- [S3 POST Policy — the hidden S3 feature](https://www.matano.dev/blog-archive/2022/02/14/s3-post-policy) and [What an S3 presigned URL actually signs](https://blog.alexrusin.com/s3-presigned-url-actually-signs/) — `content-length-range` / `starts-with` conditions exist for presigned POST only; presigned PUT constrains neither size nor content type (TD-12)
- npm registry metadata (versions, module format, engines, peer ranges) for `bullmq`, `@nestjs/bullmq`, `pg-boss`, `nanoid`, `uuid`, `sqids`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `minio`, `ioredis`, `amqplib`, `@golevelup/nestjs-rabbitmq`
