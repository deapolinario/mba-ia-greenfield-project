---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-04T15:54:28-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-04T15:51:48-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "Metadata field set to extract/persist is unspecified ('duração e metadados')"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "Thumbnail frame selection and output format/dimensions unspecified"
    resolved_by: clarification
  - id: MD-1
    status: resolved
    summary: "No TD decides access policy for upload/streaming/download endpoints"
    resolved_by: phase-03-videos/TD-11
  - id: MD-2
    status: resolved
    summary: "No TD decides accepted video formats or where the 10GB cap is enforced"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Queue Technology for Background Video Processing"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Upload Protocol for Files up to 10GB"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Upload-Completion Signal that Triggers Processing"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Object Storage Client Library"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Bucket and Object Key Layout"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Video Worker Runtime Topology"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — FFmpeg Invocation Approach"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Unique Video URL Identifier Strategy"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Streaming and Download Delivery Strategy"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Video Status Lifecycle and Processing-Failure Policy"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Access Policy for Video Upload, Streaming and Download"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "TD-12 pending — Upload Admission Policy (formats + size enforcement point)"
    resolved_by: phase-03-videos/TD-12
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

This is the first revision in which Check 1 is actually evaluable — all 12 TDs are now decided, so decided-vs-scope and decided-vs-decided contradictions can be tested rather than deferred.

No capability requires behavior that a decided TD forecloses, and no two decided choices imply mutually exclusive runtime behavior. The combinations worth stating explicitly, because each was a plausible place for a contradiction:

- **TD-02 (presigned multipart) + TD-12 (validate at init, verify at completion)** — compatible by construction: TD-12 places enforcement at the two points TD-02 leaves under API control (issuing the URLs, and finalizing the upload), precisely because the bytes in between are not observable to the API.
- **TD-03 (explicit complete endpoint) + TD-02** — compatible: the part/ETag list that `CompleteMultipartUpload` requires is exactly what the client submits to `POST /videos/:id/complete`.
- **TD-09 (presigned GET redirect) + TD-11 (owner-only)** — compatible, with a limitation both TDs state in their own bodies rather than a contradiction between them: authorization is enforced at the hop that *issues* the URL, so an issued URL remains usable until it expires. TD-09's Cons record this and name short expiry as the mitigation; TD-11's enforcement point is the issuing request. The plan's Authorization Matrix must describe the rule at that granularity ("authorized at issuance, bounded by expiry"), not as per-byte authorization.
- **TD-01 (BullMQ lock renewal) + TD-07 (`spawn`)** — mutually reinforcing rather than conflicting; see the Inherited Constraint Conflicts note below.

All 12 TDs cite a `Capability:` matching a literal bullet of `## Scope`. The Scope-Subsection orphan check stays silent: the index holds 8 `Backend` and 4 `Cross-layer` TDs and zero `Scope: Frontend`, so no TD is filtered out of the final artifact while `## UI Inventory` carries the deferred placeholder.

### Ambiguities

_None._

Both prior findings were answered in the `/plan-resolve` run and are preserved under `## Resolved Issues`. Per the merge rule, a resolved `(category, summary)` tuple is dropped rather than re-raised; re-running Check 2 against the 9 capability bullets surfaces no new ambiguity, because the two answers removed the only wordings that could not be decomposed into concrete SIs — the metadata field set (now `duration_seconds` column + normalized `metadata` JSONB) and the thumbnail frame rule (now FFmpeg's `thumbnail` filter, JPEG at 1280px width).

### Missing Decisions

_None._

The capability coverage gate passes: all **9** bullets in `## Capability Coverage` map to at least one TD, with no `—` cells. No further strategic choice was identified without a covering TD:

- The HTTP error-response envelope is inherited from `phase-02-auth/TD-07`, so the "first phase with HTTP in a subproject must define it" sub-check stays silent.
- Rate limiting on the new endpoints does **not** raise an `MD-N`: `phase-02-auth/TD-08` already decided the mechanism (`@nestjs/throttler`, scoped via module-level `APP_GUARD`), so applying it to the video endpoints is implementation resolved by the inherited decision plus best practices, not a new strategic choice.
- Cleanup of abandoned multipart uploads is not a separate missing decision — `TD-03`'s decision prose names the mechanism (an S3/MinIO lifecycle rule using the `AbortIncompleteMultipartUpload` action), so it is owned by that TD and belongs in the storage-bootstrap SI.

The shared-types contract-sync sub-type (Decisão #29) does not fire: `## UI Inventory` carries the deferred placeholder, which is in that check's never-fires list.

### Dependency Gaps

_None._

Prerequisites from prior phases are in place: videos attach to a channel, and the `Channel` entity with its 1:1 relation to `User` ships in Fase 02 (`phase-02-auth/TD-10` plus the migration delivered there); authenticated upload relies on the global JWT guard from `phase-02-auth/TD-02`; the error envelope the new endpoints emit is inherited from `phase-02-auth/TD-07`. Object storage, the queue and the worker are new infrastructure this phase introduces rather than prerequisites expected from a prior phase. Within the phase, capability ordering is implied by the bullet wording itself ("ao iniciar o upload", "após upload"), and the decided TDs make it explicit — the `TD-10` state machine sequences pre-registration → upload → processing → terminal state.

### Inherited Constraint Conflicts

_None._

This check was unevaluable in the prior revision (no TD was decided). With all 12 decided, it has now run against the 6 inherited conventions and 29 inherited TDs. Three pairings were examined closely because each is the kind of thing that *looks* like a conflict; none is one, and recording why matters for the implementation:

- **TD-01 adds Redis as a second datastore, while `phase-02-auth/TD-03` chose PostgreSQL for refresh tokens partly because "PostgreSQL is already in the stack, so no new infrastructure needed."** Not a conflict: that clause is the local rationale of a token-storage decision, not a project-wide prohibition on new datastores. No inherited convention constrains the infrastructure set. TD-01's own body records that the Postgres-backed alternative (Option B) stays the better fit the moment `@nestjs/bullmq` ships support — the trigger to revisit is a release, not a conflict to resolve now.
- **TD-01 and TD-04 both introduce new configuration surfaces**, which the Fase 01 conventions govern rather than contradict. They impose obligations the plan must carry into its SIs: a namespaced `registerAs` factory per domain in `src/config/` (`queue.config.ts`, `storage.config.ts`), new keys added to the Joi schema in `src/config/env.validation.ts`, injection via `ConfigType<typeof xxxConfig>` + `@Inject(xxxConfig.KEY)`, and `BullModule.forRootAsync` / the S3 client factory consuming those rather than reading `process.env` inline. Per the repo's Docker rule the Redis and MinIO hosts are Compose service names (`redis`, `minio`), never `localhost`.
- **TD-08's base64url alphabet (mixed case, `-`, `_`) diverges from `phase-02-auth/TD-10`'s strict `[a-z0-9_]` allowlist for channel nicknames.** Not a conflict: the two govern different identifier classes with different requirements — a human-typed, email-derived channel handle versus a machine-generated opaque video token. TD-10's rationale is explicitly about handle ergonomics; it does not constrain opaque IDs. URL paths are case-sensitive by specification, so the two coexist in `/{nickname}/{videoId}`-shaped routes without ambiguity.

The one forward-looking obligation worth flagging for `/plan-build`: `TD-11`'s owner-only rule must be expressed through the inherited global-guard + `@Public()` pattern (authentication) plus an explicit ownership check in the service/controller layer — not through a parallel authorization mechanism that bypasses the established guard.

### Unresolved Open Questions

_None._

Every TD in `## Decisions Index` carries `Status: decided`, so Check 6 emits nothing from pending TDs. The twelve `OQ-N` entries from the prior revision were all resolved in `/plan-resolve` and are preserved under `## Resolved Issues`. Inventory open questions are not applicable — `## UI Inventory` carries the deferred placeholder.

### UI Coverage Gaps

_None._

`## UI Inventory` carries the deferred placeholder, so the check is skipped by contract. For the record, the UI signal that caused the deferral is a false positive in the detector: it matches `ui` as a case-insensitive substring and fires inside the Portuguese word "arq**ui**vos" in two capability bullets. Fase 03 has no UI surface — no bullet names a screen, and `docs/project-plan.md` introduces video screens in Fase 04 (painel de gerenciamento) and Fase 05 (página de visualização).

## Resolved Issues

- **AMB-1** _(resolved_by clarification)_ — Metadata shape fixed: `duration_seconds` as a typed column (it is displayed and sorted on, so it must be queryable) plus a `metadata` JSONB column holding the normalized ffprobe subset — `width`, `height`, video codec, audio codec, container, bitrate, framerate, `size_bytes`. JSONB over discrete columns because the field set is expected to grow in Fases 04/05 without a migration per field; normalized rather than raw ffprobe output so the schema is not coupled to a tool's output format and the API does not expose it.
- **AMB-2** _(resolved_by clarification)_ — Thumbnail rule fixed: FFmpeg's `thumbnail` filter (`-vf thumbnail`), which analyses a batch of frames and picks the most representative one, output as JPEG at a fixed 1280px width preserving aspect ratio. Chosen over a fixed offset or a percentage of duration because the filter exists precisely to avoid the black/fade-in first-frame failure mode, and it behaves correctly regardless of video duration.
- **MD-1** _(resolved_by phase-03-videos/TD-11)_ — No TD decided the access policy for the upload, streaming and download endpoints. Closed by TD-11 (`Scope: Backend`), decided as owner-only for every operation in this phase.
- **MD-2** _(resolved_by phase-03-videos/TD-12)_ — No TD decided which video formats are accepted or where the 10GB ceiling is enforced. Closed by TD-12 (`Scope: Cross-layer`), decided as declared-metadata validation at init plus `HeadObject` verification at completion and `ffprobe` re-verification in the worker.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — Queue Technology for Background Video Processing: decided as **A (BullMQ 6 on Redis via @nestjs/bullmq)**.
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — Upload Protocol for Files up to 10GB: decided as **A (Presigned multipart upload, client-orchestrated)**.
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — Upload-Completion Signal that Triggers Processing: decided as **A (Explicit client callback endpoint)**.
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — Object Storage Client Library: decided as **A (AWS SDK v3)**.
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — Bucket and Object Key Layout: decided as **A (Single bucket, per-video key prefix)**.
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — Video Worker Runtime Topology: decided as **A (Separate container, shared codebase, standalone application context)**.
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — FFmpeg Invocation Approach: decided as **A (Direct child_process.spawn of ffmpeg/ffprobe)**.
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — Unique Video URL Identifier Strategy: decided as **A (crypto.randomBytes + base64url)**.
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — Streaming and Download Delivery Strategy: decided as **A (Short-lived presigned GET redirect)**.
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — Video Status Lifecycle and Processing-Failure Policy: decided as **A (Five states, retries owned by the queue)**.
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — Access Policy for Video Upload, Streaming and Download: decided as **A (Owner-only for every operation in this phase)**.
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — Upload Admission Policy — Accepted Formats and Size Enforcement Point: decided as **A (Validate declared metadata at init, verify after completion)**.
