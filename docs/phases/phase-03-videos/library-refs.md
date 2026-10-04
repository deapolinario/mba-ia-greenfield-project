---
libs:
  "bullmq":
    version: "^6.3.x"
    resolved_version: "6.3.9"
    context7_id: null
    source: "https://docs.bullmq.io/"
    fetched_at: "2026-10-04T15:53:09-03:00"
  "@nestjs/bullmq":
    version: "^12.0.0"
    resolved_version: "12.0.0"
    context7_id: null
    source: "https://docs.nestjs.com/techniques/queues"
    fetched_at: "2026-10-04T15:53:09-03:00"
  "ioredis":
    version: "^6.0.0"
    resolved_version: "6.0.0"
    context7_id: null
    source: "https://registry.npmjs.org/ioredis"
    fetched_at: "2026-10-04T15:53:09-03:00"
  "@aws-sdk/client-s3":
    version: "^3.x"
    resolved_version: "3.1141.0"
    context7_id: null
    source: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html"
    fetched_at: "2026-10-04T15:53:09-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    resolved_version: "3.1141.0"
    context7_id: null
    source: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html"
    fetched_at: "2026-10-04T15:53:09-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-04T15:51:48-03:00"
---

# phase-03-videos — Library References

> **Provenance note.** `CLAUDE.md` and `plan-resolve` both specify fetching library docs through the **context7** MCP server, which is **not configured in this repository** (`.mcp.json` declares only `postgres`). Every `context7_id` above is therefore `null` and each entry carries a `source:` URL instead. Versions were resolved against the **npm registry** (authoritative for published version, module format, `engines` and peer ranges); API surfaces were distilled from the **official vendor documentation** cited per entry. If context7 is enabled later, re-running `/plan-resolve phase-03-videos` after deleting this file will re-materialize the cache through the sanctioned path.

Scope of this cache: only the surfaces the phase's decided TDs actually use. It is not a general reference.

---

### bullmq

**Decided by:** `phase-03-videos/TD-01` (Option A — BullMQ 6 on Redis)

Installed line: `6.3.9`. Ships CommonJS (`main: ./dist/cjs/index.js`), so it works with this project's CJS build — unlike `pg-boss`, which is ESM-only. `engines.node >= 14.17`. Peer dependencies are optional per backend: `ioredis >= 5`, `redis >= 5`, `pg >= 8` (the `pg` peer exists because v6 introduced the `IQueueBackend` abstraction with an official PostgreSQL backend — not used here, see TD-01 Option B).

#### Long-running jobs — the constraint that matters most for this phase

A worker takes a **lock** on a job while processing and must periodically renew it to signal progress. The renewal period is governed by `stalledInterval` (the docs note you normally should not need to change it). If the lock is not renewed in time, the job is **moved back to `waiting` and reprocessed by another worker** — or, once `maxStalledCount` is reached, moved to the `failed` set.

The documented failure mode is directly relevant here: *"When the event loop becomes saturated by CPU-intensive work, the worker cannot renew its lock promptly."* The guidance is to return control to the event loop often enough.

**This is why `TD-07`'s choice of `child_process.spawn` matters beyond ergonomics.** FFmpeg runs as a separate OS process and the worker merely `await`s it, so the Node event loop stays free to renew the lock across a multi-minute transcode. An in-process alternative (`ffmpeg.wasm`, TD-07 Option C) would saturate the loop and produce spurious stalled-job re-dispatch — i.e. the same video processed twice. Implementations must not move FFmpeg work onto the event loop.

#### Retry and failure semantics (feeds `TD-10`)

Job options set at `add()` time shape retry behavior: `attempts` (total tries) and `backoff` (`{ type: 'exponential', delay: <ms> }`). `TD-10` assigns retry ownership to the queue: only after the final attempt fails does the `videos` row become `failed`, with the error recorded. Attempt counting stays in BullMQ — do **not** mirror it into a `processing_attempts` column (that was TD-10 Option C, rejected for creating two sources of truth).

---

### @nestjs/bullmq

**Decided by:** `phase-03-videos/TD-01` (Option A)

Installed line: `12.0.0` (published 2026-08-27). `peerDependencies` accept `@nestjs/core ^10 || ^11 || ^12` and `bullmq ^3 || ^4 || ^5 || ^6`, so NestJS 11 + bullmq 6 is a supported pair **today**.

**Known gap (load-bearing for TD-01):** this released version does **not** support BullMQ's PostgreSQL backend. The feature request (nestjs/bull issue #2903) was opened 2026-09-04 and merged after the 12.0.0 release, so no published version carries it. Revisiting TD-01 Option B becomes viable when a release ships that support.

#### API surface used by this phase

**Root module** — `BullModule.forRoot({ connection: { host, port } })`, with `forRootAsync()` for factory/DI configuration. Other root options: `prefix` (key namespace), `defaultJobOptions` (shared job behavior), `settings`.

Per the inherited Fase 01 conventions (`phase-01-configuracao-base/TD-01`/`TD-03`), the connection must come from a namespaced `registerAs` config factory injected via `ConfigType<typeof queueConfig>` and `forRootAsync` — not from `process.env` read inline — and the new env keys must be added to the Joi schema in `src/config/env.validation.ts`. Per the repo's Docker rule, the Redis host is the Compose service name (`redis`), never `localhost`.

**Queue registration** — `BullModule.registerQueue({ name: 'video-processing' })`. The name is the injection token and is what binds a consumer to the queue. `configKey` overrides the connection per queue.

**Producer** — `@InjectQueue('video-processing') private queue: Queue` in the constructor; enqueue with `queue.add('<job-name>', data, options)` where options carry `attempts`, `backoff`, `delay`, `priority`.

**Consumer** — a class decorated `@Processor('video-processing')` that `extends WorkerHost` and implements `async process(job: Job): Promise<...>`. Dispatch on `job.name` when a queue carries more than one job type (this phase has one).

Because the consumer lives in the worker container (`TD-06`, Option A — separate container, shared codebase, standalone application context), the worker's module must import the queue registration but **not** the HTTP controllers; it boots via `NestFactory.createApplicationContext()` with no listener.

---

### ioredis

**Decided by:** `phase-03-videos/TD-01` (Option A) — transitively, as BullMQ's Redis driver

Installed line: `6.0.0`. Declared as an optional peer dependency of `bullmq@6` (`ioredis >= 5.0.0`), so it must be installed explicitly alongside `bullmq`. CommonJS-compatible. No direct application code is expected to import it in this phase — BullMQ owns the connection; the dependency exists so BullMQ can resolve its driver.

---

### @aws-sdk/client-s3

**Decided by:** `phase-03-videos/TD-04` (Option A — AWS SDK v3), with `TD-02`, `TD-05`, `TD-09`, `TD-12` consuming it

Installed line: `3.1141.0`. CommonJS-compatible. Pointed at MinIO locally via `endpoint` + `forcePathStyle: true`; the same code targets real S3 in production by changing only those options (this portability is the whole basis of TD-04).

#### Multipart upload — the operation sequence (feeds `TD-02` and `TD-03`)

Three steps, with commands named after the REST operations:

1. **`CreateMultipartUploadCommand`** → returns an **upload ID** required by every later call.
2. **`UploadPartCommand`** per part, each with a part number in **1..10,000**. For each part the client must record the **part number and the returned ETag**.
3. **`CompleteMultipartUploadCommand`** → must carry the upload ID plus the list of part numbers and their ETags. S3 concatenates parts in ascending part-number order.

`AbortMultipartUploadCommand` stops an upload; `ListPartsCommand` / `ListMultipartUploadsCommand` enumerate state. The docs are explicit that `ListParts` output must **not** be used to build the Complete request — the client maintains its own part/ETag list. Under `TD-03` (Option A) that list arrives from the client in the `POST /videos/:id/complete` body.

**Size constraints** (verified): a single `PUT` caps at **5 GB**, which is what forces multipart for this phase's 10GB target; multipart spans **5 MB to 50 TB**. With additional checksums enabled, part numbers must be **consecutive starting at 1** — non-consecutive numbering returns HTTP 500.

**Orphan-upload risk and its mitigation (TD-03's open gap).** *"After you initiate a multipart upload, there is no expiry; you must explicitly complete or stop the multipart upload"* — and uploaded parts are billed until then. The sanctioned mitigation is a bucket **lifecycle rule using the `AbortIncompleteMultipartUpload` action** to delete incomplete uploads after N days. This is the concrete mechanism TD-03 relies on to cover a client that uploads and never calls `complete`; provisioning it belongs in the storage-bootstrap SI.

#### Other operations this phase uses

- **`HeadObjectCommand`** — `TD-12` (Option A) calls it at completion time to verify the object's real size against the 10GB cap and reject/delete when the declared size was a lie.
- **`GetObjectCommand`** — presigned for playback/download under `TD-09`; S3/MinIO implement HTTP `Range` / `206` natively on the resulting URL, which is why no byte-range code is needed in the API.

---

### @aws-sdk/s3-request-presigner

**Decided by:** `phase-03-videos/TD-04` (Option A), consumed by `TD-02`, `TD-09`, `TD-12`

Installed line: `3.1141.0`. Provides `getSignedUrl(client, command, { expiresIn })`, used in this phase to presign `UploadPartCommand` (upload) and `GetObjectCommand` (streaming/download).

#### What a presigned URL does and does not constrain — the fact behind `TD-12`

A presigned URL carries the permissions of the IAM principal that created it and is a **bearer token**: anyone holding it can use it until expiry. What is signed is the **bucket, key, HTTP method and expiry** — and, when explicitly included, specific signed headers.

**A presigned `PUT` constrains neither object size nor content type.** The `content-length-range` / `starts-with` policy conditions that *would* let the storage reject an oversized or wrong-typed upload before accepting bytes exist only for presigned **POST** (single-object form upload), which does not apply to multipart `UploadPart`. This is precisely why `TD-12` places enforcement in the application: declared metadata validated at init, real size verified via `HeadObject` at completion, and container/codec re-verified by the worker's `ffprobe` pass. TD-12 Option B's "sign each part with a fixed `Content-Length`" is the available structural tightening if abuse is ever observed.

**Expiry semantics relevant to `TD-09`.** Expiry is checked at request time, so a download already in flight when the URL expires continues; a *new* request (or a resumed one) after expiry fails. A presigned URL also dies early if the credentials that signed it expire or are revoked — with static credentials (the MinIO case in dev) the configured `expiresIn` governs. Since TD-09 accepts that an issued URL is valid for its whole lifetime, `expiresIn` should be short; it is the only lever bounding access, because per-request revocation was the advantage of the rejected Option B.
