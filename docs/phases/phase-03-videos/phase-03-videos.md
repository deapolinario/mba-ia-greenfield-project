---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-04T15:54:28-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-04T15:54:03-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-04T15:51:48-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-23T10:02:52-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-09-23T10:02:52-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver large-file video upload that never routes bytes through the API (presigned multipart to S3-compatible storage, up to 10GB), automatic background processing in a dedicated FFmpeg worker that extracts duration/metadata and generates a thumbnail, a collision-free unique URL per video, and streaming plus download delivery — establishing the storage, queue and worker infrastructure that Fases 04–05 build their video management and playback surfaces on.

---

## Step Implementations

### SI-03.1 — Dependências, namespaces de configuração e validação de env

**Description:** Instalar as bibliotecas da fase e criar os dois namespaces de configuração (fila e storage) seguindo o padrão `registerAs` herdado, estendendo o schema Joi — nenhuma lógica de domínio, só fundação.

**Technical actions:**

1. Instalar dependências de produção em `nestjs-project`: `bullmq@^6.3.x`, `@nestjs/bullmq@^12.0.0`, `ioredis@^6.0.0` (per `phase-03-videos/TD-01`), `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x` (per `phase-03-videos/TD-04`)
2. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` lendo `REDIS_HOST` (string, default `'redis'`) e `REDIS_PORT` (number, default `6379`); host é o nome do serviço do Compose, nunca `localhost`
3. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE` (boolean, default `true`), `UPLOAD_PART_SIZE_BYTES` (number, default `8388608`), `PRESIGN_UPLOAD_TTL_SECONDS`, `PRESIGN_DOWNLOAD_TTL_SECONDS`, `UPLOAD_MAX_SIZE_BYTES` (number, default `10737418240`), `UPLOAD_ACCEPTED_MIME_TYPES` (CSV)
4. Estender `src/config/env.validation.ts` — adicionar todas as variáveis novas ao schema Joi (segredos do S3 `required`, demais com default) e atualizar `.env.example` com defaults compatíveis com o Compose

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: schema aceita os defaults novos e rejeita `S3_*` ausente | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- A aplicação inicia sem erro quando todas as variáveis novas estão presentes — `GET /` continua retornando `200`
- Iniciar a aplicação sem `S3_ACCESS_KEY_ID` causa erro de validação Joi no bootstrap e a aplicação não sobe
- `UPLOAD_MAX_SIZE_BYTES` tem valor efetivo `10737418240` quando a variável não é informada

---

### SI-03.2 — Infraestrutura no Compose: Redis, MinIO, bootstrap do bucket e container do worker

**Description:** Subir a infraestrutura nova da fase — fila, object storage e o container do worker com FFmpeg — toda via `docker compose`, com o bucket e a lifecycle rule provisionados automaticamente.

**Technical actions:**

1. Adicionar serviço `redis` ao `nestjs-project/compose.yaml` — `redis:8-alpine`, healthcheck `redis-cli ping`; `nestjs-api` passa a depender dele com `condition: service_healthy` (per `phase-03-videos/TD-01`)
2. Adicionar serviço `minio` — `minio/minio`, portas `9000` (API) e `9001` (console), volume nomeado, healthcheck no endpoint de health; credenciais via env
3. Adicionar serviço one-shot `minio-bootstrap` — cria o bucket de `S3_BUCKET` idempotentemente. A lifecycle rule `AbortIncompleteMultipartUpload` citada em `phase-03-videos/TD-03` não é aplicável neste ambiente: o servidor MinIO rejeita essa ação de lifecycle (confirmado via `mc` e via chamada direta à API S3 com `aws-cli` — limitação do servidor, não das ferramentas cliente; [minio/minio#16120](https://github.com/minio/minio/issues/16120)). A limpeza de uploads abandonados fica a cargo exclusivo do reaper em nível de aplicação (SI-03.11)
4. Instalar `ffmpeg` (que fornece `ffmpeg` e `ffprobe`) na imagem usada pelo worker em `Dockerfile.dev` (per `phase-03-videos/TD-07`)
5. Adicionar serviço `video-worker` — mesmo build e mesmo volume de código da API, sem porta publicada, dependendo de `db`, `redis` e `minio` saudáveis (per `phase-03-videos/TD-06`)

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.1 — as variáveis de ambiente consumidas pelos serviços novos são definidas lá

**Acceptance criteria:**

- `docker compose up -d` sobe `nestjs-api`, `db`, `mailpit`, `redis`, `minio` e `video-worker`, e `docker compose ps` mostra todos em `running`
- `docker compose exec redis redis-cli ping` responde `PONG`
- O bucket configurado em `S3_BUCKET` existe após o `minio-bootstrap` rodar, e rodar o bootstrap uma segunda vez não falha
- `docker compose exec video-worker ffprobe -version` e `ffmpeg -version` respondem com a versão instalada

---

### SI-03.3 — Entidade `Video`, migration e `VideosModule`

**Description:** Criar a entidade de vídeo ligada ao canal com o ciclo de status completo, gerar a migration e registrar o módulo — a persistência que todo o resto da fase escreve e lê.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com todos os campos da § Data Model: `public_id` (varchar(16), unique), `channel_id` (uuid FK → channels), `title`, `status` (enum `draft`/`uploading`/`processing`/`ready`/`failed`, default `draft`), `storage_key`, `thumbnail_key` (nullable), `upload_id` (nullable), `declared_size_bytes` (bigint, nullable), `declared_mime_type` (nullable), `duration_seconds` (integer, nullable), `metadata` (jsonb, nullable), `processing_error` (text, nullable), timestamps. Relação `@ManyToOne(() => Channel)` com `@JoinColumn({ name: 'channel_id' })`
2. Declarar os índices da § Data Model — unique em `public_id`, índice em `(channel_id)` e índice em `(status)`
3. Criar `src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])` nos imports, exportando `TypeOrmModule`
4. Gerar a migration via `npm run migration:generate -- src/database/migrations/CreateVideos` e revisar o SQL gerado (enum PostgreSQL, FK, índices)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraint unique de `public_id`, default `draft` do `status`, valores aceitos do enum, nullability de `thumbnail_key`/`duration_seconds`/`metadata`, timestamps automáticos | `src/videos/entities/video.entity.integration-spec.ts` |
| `VideosModule` | Integration: compila com `TypeOrmModule.forFeature([Video])` (abre conexão real, por isso sufixo `integration-spec`) | `src/videos/videos.module.integration-spec.ts` |
| migrations | Integration: a migration aplica e reverte criando/removendo a tabela `videos` | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com todas as colunas, o tipo enum do status, a FK para `channels` e os três índices
- Inserir dois vídeos com o mesmo `public_id` falha com violação de constraint unique
- Um vídeo recém-criado sem `status` explícito é persistido com `status = 'draft'`
- Inserir um vídeo com `status` fora do conjunto de cinco valores é rejeitado pelo enum
- Inserir um vídeo com `channel_id` inexistente falha com violação de FK

---

### SI-03.4 — `StorageModule` e `QueueModule`: adaptadores de infraestrutura

**Description:** Encapsular as duas infraestruturas novas em módulos finos — o client S3 com as operações de multipart/presign e o registro da fila BullMQ — para que os endpoints e o worker consumam abstrações, não SDKs diretamente.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` — provider do `S3Client` construído por factory a partir de `storageConfig` via `ConfigType<typeof storageConfig>` + `@Inject(storageConfig.KEY)`, com `endpoint` e `forcePathStyle: true` para falar com o MinIO (per `phase-03-videos/TD-04`)
2. Criar `src/storage/storage.service.ts` — construtores de chave `videos/{publicId}/original` e `videos/{publicId}/thumbnail.jpg` (per `phase-03-videos/TD-05`) e os wrappers `createMultipartUpload`, `presignUploadPart`, `completeMultipartUpload`, `abortMultipartUpload`, `headObject`, `presignGet` (com override opcional de `response-content-disposition`), `putObject` e `deleteObject`
3. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync` lendo `queueConfig` + `BullModule.registerQueue({ name: 'video-processing' })`, exportando `BullModule` (per `phase-03-videos/TD-01`)
4. Criar `src/videos/video-processing.job.ts` — o tipo do payload do job (`videoId`, `publicId`, `storageKey`) conforme § Events/Messages, importado tanto pelo produtor quanto pelo consumidor

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: ciclo multipart real contra o MinIO do Compose (create → presign part → PUT → complete → headObject → delete) e geração de presigned GET | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Integration: compila com a factory do `S3Client` resolvida a partir de `storageConfig` | `src/storage/storage.module.integration-spec.ts` |
| `QueueModule` | Integration: compila com `forRootAsync` + `registerQueue` conectando no Redis do Compose | `src/queue/queue.module.integration-spec.ts` |

Sem linha de E2E: nenhum dos dois módulos expõe rota HTTP própria.

**Dependencies:** SI-03.1 (namespaces de config), SI-03.2 (Redis e MinIO no ar para os testes de integração)

**Acceptance criteria:**

- `StorageService` sobe um objeto de múltiplas partes no MinIO e o `headObject` subsequente reporta o tamanho total correto
- Uma URL de `UploadPart` pré-assinada aceita um `PUT` da parte correspondente e retorna um `ETag`
- Uma URL de GET pré-assinada serve o objeto e responde `206 Partial Content` quando a requisição carrega header `Range`
- `abortMultipartUpload` libera as partes — o upload deixa de aparecer na listagem de multipart em andamento
- Os construtores de chave produzem exatamente `videos/{publicId}/original` e `videos/{publicId}/thumbnail.jpg`
- `QueueModule` compila e um job enfileirado fica visível na fila `video-processing` do Redis

---

### SI-03.5 — `POST /videos`: início do upload com pré-cadastro do rascunho e partes pré-assinadas

**Description:** O handshake de início: valida a admissão do arquivo declarado, pré-cadastra o vídeo, abre o multipart no storage e devolve as URLs pré-assinadas — sem nenhum byte atravessar a API.

**Route:** POST /videos

**Test Specs:** see `nestjs-project/specs/videos-upload-init.plan.md`

**Authorization:** Owner (autenticado, cria sob o próprio canal) — per § Authorization Matrix

**Technical actions:**

1. Criar `src/videos/public-id.util.ts` — gera o identificador público com `crypto.randomBytes(8).toString('base64url')`, produzindo 11 caracteres URL-safe (per `phase-03-videos/TD-08`)
2. Criar `src/videos/dto/init-upload.dto.ts` — `title`, `size_bytes`, `mime_type` com os decoradores `class-validator` das § Validation Rules, mais os decoradores `@ApiProperty`/`@ApiOperation`/`@ApiResponse` exigidos pela revisão de `openapi-docs-nestjs/TD-01`
3. Implementar `VideosService.initUpload` — checagem de admissão (teto de `UPLOAD_MAX_SIZE_BYTES` e allowlist de MIME, per `phase-03-videos/TD-12`), resolução do canal do usuário autenticado, geração de `public_id` com retry em colisão de unique, persistência da linha e transição `draft → uploading`, `createMultipartUpload` e pré-assinatura de `ceil(size_bytes / part_size)` URLs de parte
4. Criar `src/videos/videos.controller.ts` com `POST /videos` retornando `201` conforme § API Contracts, e registrar `VideosController` + `VideosService` em `VideosModule` importando `StorageModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generatePublicId` | Unit: comprimento de 11 caracteres, alfabeto URL-safe, ausência de colisão em volume alto | `src/videos/public-id.util.spec.ts` |
| `VideosService.initUpload` | Unit: ramos de rejeição por tamanho e por MIME, retry em colisão de `public_id` (repos mockados) | `src/videos/videos.service.spec.ts` |
| `VideosService.initUpload` | Integration: linha persistida em `uploading` com `upload_id` e `storage_key` preenchidos, contra DB e MinIO reais | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.3 (entidade e módulo), SI-03.4 (StorageModule)

**Acceptance criteria:**

- `POST /videos` com corpo válido retorna `201` com `public_id`, `status: "uploading"`, `upload_id`, `part_size_bytes` e um array `parts` não vazio
- Cada entrada de `parts` carrega `part_number` 1-based ascendente e consecutivo, uma `url` e um `expires_at`
- `POST /videos` com `size_bytes` acima de 10 GiB retorna `400` com `error: "VIDEO_SIZE_EXCEEDS_LIMIT"`
- `POST /videos` com `mime_type` fora da allowlist retorna `400` com `error: "VIDEO_MIME_TYPE_NOT_ACCEPTED"`
- `POST /videos` sem token de acesso retorna `401`
- Após uma chamada bem-sucedida existe uma linha em `videos` com `status = 'uploading'` e `channel_id` igual ao canal do usuário autenticado
- Dois vídeos criados em sequência recebem `public_id` distintos

---

### SI-03.6 — `POST /complete` e `DELETE /upload`: verificação da conclusão e enfileiramento

**Description:** Fecha o handshake: finaliza o multipart, confere o objeto real contra o tamanho declarado, transiciona para `processing` e enfileira o job — e oferece o caminho de abort para liberar as partes de um upload desistido.

**Route:** POST /videos/:publicId/complete, DELETE /videos/:publicId/upload

**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`

**Authorization:** Owner only — per § Authorization Matrix

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` — array `parts` com `part_number` e `etag` validados conforme § Validation Rules, mais os decoradores OpenAPI explícitos
2. Implementar `VideosService.completeUpload` — guarda de propriedade (`channel_id` do vídeo contra o canal do usuário, per `phase-03-videos/TD-11`), guarda de estado (`status` deve ser `uploading`), `completeMultipartUpload` com a lista de partes recebida do cliente, verificação via `headObject` do tamanho real contra o teto (deleta o objeto e move para `failed` se exceder, per `phase-03-videos/TD-12`), limpeza de `upload_id`, transição para `processing` e enfileiramento de `video-processing.process` conforme § Events/Messages
3. Implementar `VideosService.abortUpload` — mesmas guardas, `abortMultipartUpload` e retorno do vídeo para `draft` com `upload_id` limpo
4. Adicionar ao `VideosController` as rotas `POST /:publicId/complete` (`200`) e `DELETE /:publicId/upload` (`204`), importando `QueueModule` em `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: ramos de não-proprietário, estado inválido e tamanho real acima do teto (repos e storage mockados) | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: transição para `processing` e job presente na fila real; e o caminho de tamanho excedido deixando o vídeo em `failed` | `src/videos/videos.service.integration-spec.ts` |
| `VideosService.abortUpload` | Integration: partes liberadas no MinIO e vídeo de volta em `draft` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 (a linha em `uploading` e o `upload_id` vêm de lá), SI-03.4 (QueueModule para enfileirar)

**Acceptance criteria:**

- `POST /videos/:publicId/complete` com as partes corretas retorna `200` com `status: "processing"` e deixa exatamente um job na fila `video-processing`
- Após a conclusão, a linha do vídeo tem `upload_id` nulo e o objeto existe no storage sob `videos/{publicId}/original`
- `POST /videos/:publicId/complete` por um usuário que não é dono do canal retorna `403` com `error: "VIDEO_NOT_OWNED"`
- `POST /videos/:publicId/complete` em um vídeo cujo `status` não é `uploading` retorna `409` com `error: "VIDEO_INVALID_STATE_TRANSITION"`
- Quando o objeto finalizado excede o teto, a resposta é `400` com `error: "VIDEO_SIZE_EXCEEDS_LIMIT"`, o objeto é removido do storage e o vídeo fica em `failed`
- `DELETE /videos/:publicId/upload` retorna `204` e o vídeo volta para `status = 'draft'`
- `POST /videos/:publicId/complete` com `publicId` inexistente retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.7 — Bootstrap do container do worker e registro do processor

**Description:** Dar ao worker um processo próprio: um módulo sem controllers, um entrypoint que sobe contexto de aplicação sem listener HTTP, e o consumidor da fila registrado — isolando o FFmpeg da CPU que atende requisições.

**Technical actions:**

1. Criar `src/worker/worker.module.ts` — módulo só-worker importando `ConfigModule`, `TypeOrmModule.forRootAsync` (mesma factory de `databaseConfig`, per convenção herdada da Fase 01), `StorageModule`, `QueueModule` e os providers de processamento; **nenhum controller** (per `phase-03-videos/TD-06`)
2. Criar `src/worker/main.worker.ts` — bootstrap via `NestFactory.createApplicationContext(WorkerModule)`, sem `app.listen()`, com shutdown hooks habilitados para o worker encerrar jobs em andamento de forma limpa
3. Criar `src/videos/video-processing.processor.ts` — classe `@Processor('video-processing')` estendendo `WorkerHost`, com `concurrency` baixo (1–2, porque o trabalho é CPU-bound) e `process(job)` delegando ao serviço de processamento
4. Adicionar o script `start:worker` ao `package.json` e apontar o `command` do serviço `video-worker` do Compose para ele

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Integration: compila e resolve o processor, com DB, Redis e MinIO reais; confirma que nenhum controller está registrado | `src/worker/worker.module.integration-spec.ts` |

**Dependencies:** SI-03.4 (QueueModule e StorageModule), SI-03.2 (o serviço `video-worker` e os binários FFmpeg na imagem)

**Acceptance criteria:**

- `docker compose logs video-worker` mostra o contexto da aplicação iniciado sem erro e sem log de servidor HTTP escutando
- O worker consome um job enfileirado manualmente na fila `video-processing` e marca o job como processado no Redis
- `WorkerModule` compila sem registrar nenhuma rota HTTP
- Parar o container do worker durante um job em andamento não deixa o job travado em estado ativo — ele volta para `waiting` e é reprocessado

---

### SI-03.8 — Processamento FFmpeg: metadados, thumbnail e transições de status

**Description:** O trabalho que a fase existe para fazer: extrair duração e metadados com `ffprobe`, gerar o thumbnail com `ffmpeg`, gravar o resultado e levar o vídeo a `ready` — ou a `failed` quando as tentativas da fila se esgotam.

**Technical actions:**

1. Criar `src/videos/ffmpeg.service.ts` — invoca `ffprobe -v error -print_format json -show_format -show_streams` via `child_process.spawn` e normaliza a saída para o shape de `metadata` da § Data Model; invoca `ffmpeg -vf thumbnail` com escala de largura 1280 preservando proporção, saída JPEG, também via `spawn`, com timeout e `kill` em caso de travamento (per `phase-03-videos/TD-07`)
2. Criar `src/videos/video-processing.service.ts` — resolve o objeto de origem pela `storage_key`, extrai duração e metadados, **reconfere o container/codec real contra o `declared_mime_type`** (per `phase-03-videos/TD-12`), gera o thumbnail e o sobe em `videos/{publicId}/thumbnail.jpg`, grava `duration_seconds`, `metadata` e `thumbnail_key`, e transiciona para `ready`
3. Implementar o caminho de falha — a fila faz retry com backoff exponencial dentro de `attempts`; somente após a última tentativa o serviço grava `status = 'failed'` e a razão em `processing_error` (per `phase-03-videos/TD-10`), sem espelhar contagem de tentativas em coluna
4. Garantir idempotência conforme § Events/Messages — reexecutar o job sobre o mesmo `videoId` sobrescreve a mesma chave determinística de thumbnail e as mesmas colunas, convergindo em vez de duplicar estado

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfmpegService` | Unit: construção dos argumentos de `ffprobe`/`ffmpeg` e parse/normalização da saída JSON (processo mockado) | `src/videos/ffmpeg.service.spec.ts` |
| `FfmpegService` | Integration: binários reais sobre um fixture de vídeo curto — duração extraída e JPEG gerado com 1280px de largura | `src/videos/ffmpeg.service.integration-spec.ts` |
| `VideoProcessingService` | Integration: fluxo completo contra MinIO e DB reais levando o vídeo a `ready` com `metadata` populado; e o caminho de MIME divergente levando a `failed` | `src/videos/video-processing.service.integration-spec.ts` |
| `VideoProcessingService` | Integration: reexecutar o mesmo job converge (mesma chave de thumbnail, mesmas colunas) em vez de duplicar | `src/videos/video-processing.service.integration-spec.ts` |

**Dependencies:** SI-03.7 (o worker e o processor que invocam este serviço), SI-03.4 (StorageService para ler a origem e gravar o thumbnail)

**Acceptance criteria:**

- Concluído um upload de um vídeo válido, o vídeo chega a `status = 'ready'` sem intervenção manual
- Um vídeo `ready` tem `duration_seconds` preenchido com a duração real do arquivo e `metadata` com `width`, `height`, `video_codec`, `container` e `size_bytes` preenchidos
- Existe um objeto JPEG em `videos/{publicId}/thumbnail.jpg` com 1280px de largura, e `thumbnail_key` aponta para ele
- O thumbnail gerado não é um frame preto para um vídeo cujo primeiro frame é preto — a seleção usa o filtro `thumbnail` do FFmpeg
- Um arquivo que não é vídeo, ou cujo container real divirja do `declared_mime_type`, leva o vídeo a `status = 'failed'` com `processing_error` preenchido
- Um vídeo que falhou tem `processing_error` não nulo e `duration_seconds`, `metadata` e `thumbnail_key` nulos
- Reexecutar o job de um vídeo já `ready` o mantém `ready`, sem criar um segundo objeto de thumbnail

---

### SI-03.9 — `GET /videos/:publicId`: leitura do estado do vídeo

**Description:** O endpoint pelo qual o cliente observa a transição `processing → ready | failed` — sem ele, o processamento automático da fase não é verificável de fora.

**Route:** GET /videos/:publicId

**Test Specs:** see `nestjs-project/specs/videos-read.plan.md`

**Authorization:** Owner only — per § Authorization Matrix

**Technical actions:**

1. Implementar `VideosService.findByPublicIdForOwner` — busca por `public_id`, `404` quando não existe e guarda de propriedade retornando `403` quando o canal não é do usuário autenticado (per `phase-03-videos/TD-11`)
2. Criar a serialização da resposta conforme § API Contracts — expõe `public_id`, `title`, `status`, `duration_seconds`, `metadata`, `processing_error` e `created_at`, e pré-assina `thumbnail_url` a partir de `thumbnail_key` quando o vídeo está `ready` (nulo nos demais estados)
3. Adicionar `GET /:publicId` ao `VideosController` com os decoradores OpenAPI explícitos por status code (per a revisão de `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findByPublicIdForOwner` | Integration: retorna o vídeo do dono, `404` para `publicId` inexistente e `403` para vídeo de outro canal, contra DB real | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 (a linha a ser lida), SI-03.4 (StorageService para pré-assinar o thumbnail)

**Acceptance criteria:**

- `GET /videos/:publicId` do próprio vídeo retorna `200` com `public_id`, `title` e `status`
- Para um vídeo em `processing`, a resposta traz `duration_seconds`, `metadata` e `thumbnail_url` nulos
- Para um vídeo em `ready`, a resposta traz `duration_seconds` numérico, `metadata` populado e uma `thumbnail_url` que serve a imagem
- Para um vídeo em `failed`, a resposta traz `processing_error` não nulo
- `GET /videos/:publicId` de um vídeo de outro usuário retorna `403` com `error: "VIDEO_NOT_OWNED"`
- `GET /videos/:publicId` com `publicId` inexistente retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `GET /videos/:publicId` sem token de acesso retorna `401`

---

### SI-03.10 — Streaming e download: redirect para URL pré-assinada

**Description:** As duas entregas de bytes da fase. A API autoriza e redireciona; o storage serve o conteúdo e implementa `Range`/`206` nativamente, então a reprodução começa sem download completo e nenhum byte de vídeo atravessa a API.

**Route:** GET /videos/:publicId/stream, GET /videos/:publicId/download

**Test Specs:** see `nestjs-project/specs/videos-delivery.plan.md`

**Authorization:** Owner only, e somente quando `status = ready` — per § Authorization Matrix

**Technical actions:**

1. Implementar `VideosService.buildStreamUrl` — reusa a guarda de propriedade de SI-03.9, acrescenta guarda de estado (`status` deve ser `ready`, senão `409 VIDEO_NOT_READY`) e pré-assina um GET sobre `storage_key` com TTL de `PRESIGN_DOWNLOAD_TTL_SECONDS` (per `phase-03-videos/TD-09`)
2. Implementar `VideosService.buildDownloadUrl` — mesmas guardas, pré-assinando com override de `response-content-disposition: attachment` para o navegador salvar em vez de reproduzir
3. Adicionar ao `VideosController` as rotas `GET /:publicId/stream` e `GET /:publicId/download`, ambas respondendo `302` com o `Location` apontando para a URL pré-assinada e sem corpo

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.buildStreamUrl` / `buildDownloadUrl` | Unit: guardas de propriedade e de estado, e presença do override de disposition apenas no caminho de download (storage mockado) | `src/videos/videos.service.spec.ts` |
| `VideosService.buildStreamUrl` / `buildDownloadUrl` | Integration: a URL pré-assinada emitida serve o objeto do MinIO, honra header `Range` com `206` e carrega `Content-Disposition: attachment` no caminho de download | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.9 (a guarda de propriedade e a busca por `public_id`), SI-03.8 (só um vídeo que chegou a `ready` é entregável)

**Acceptance criteria:**

- `GET /videos/:publicId/stream` de um vídeo `ready` do próprio usuário retorna `302` com header `Location` preenchido e sem corpo
- Seguir o `Location` com um header `Range` retorna `206 Partial Content` com apenas o intervalo pedido — a reprodução não exige o arquivo inteiro
- `GET /videos/:publicId/download` retorna `302` cuja URL, ao ser seguida, responde com `Content-Disposition: attachment`
- `GET /videos/:publicId/stream` de um vídeo em `draft`, `uploading`, `processing` ou `failed` retorna `409` com `error: "VIDEO_NOT_READY"`
- `GET /videos/:publicId/stream` de um vídeo de outro usuário retorna `403` com `error: "VIDEO_NOT_OWNED"`
- `GET /videos/:publicId/stream` sem token de acesso retorna `401`
- A URL pré-assinada deixa de ser aceita pelo storage após o TTL configurado expirar

---

### SI-03.11 — Reaper de uploads abandonados

**Description:** Fecha o furo que o handshake com callback explícito deixa: um cliente que inicia o upload e desaparece deixa a linha em `uploading` e partes sendo cobradas no storage. Este SI recolhe esses casos.

**Technical actions:**

1. Criar `src/videos/abandoned-upload.reaper.ts` — busca vídeos em `status = 'uploading'` com `updated_at` anterior ao corte configurável, chama `abortMultipartUpload` para cada um e os retorna a `draft` com `upload_id` limpo. A separação `draft`/`uploading` da § Data Model é o que torna essa busca possível sem tocar rascunhos legítimos (per `phase-03-videos/TD-10`)
2. Agendar a execução periódica e adicionar a variável de corte (`ABANDONED_UPLOAD_CUTOFF_HOURS`) ao `storage.config.ts` e ao schema Joi, seguindo o padrão de SI-03.1

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `AbandonedUploadReaper` | Integration: um vídeo em `uploading` mais antigo que o corte volta a `draft` com as partes liberadas no MinIO; um vídeo em `uploading` recente e um em `draft` permanecem intocados | `src/videos/abandoned-upload.reaper.integration-spec.ts` |

Sem linha de E2E: o reaper não expõe rota HTTP.

**Dependencies:** SI-03.6 (o abort de multipart que o reaper reusa), SI-03.3 (o índice em `(status)` que torna a busca eficiente)

**Acceptance criteria:**

- Um vídeo em `uploading` com `updated_at` anterior ao corte é retornado a `status = 'draft'` com `upload_id` nulo após a execução do reaper
- As partes do upload abandonado deixam de aparecer na listagem de multipart em andamento do bucket
- Um vídeo em `uploading` mais recente que o corte não é alterado pelo reaper
- Um vídeo em `draft` nunca é tocado pelo reaper, independentemente da idade
- Rodar o reaper duas vezes seguidas não produz erro nem efeito adicional

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated (`uuid_generate_v4()`) |
| public_id | varchar(16) | unique, not null — the unique URL identifier (per `phase-03-videos/TD-08`) |
| channel_id | uuid | FK → channels.id, not null — owning channel |
| title | varchar(255) | not null |
| status | enum | not null, default `draft` — values: `draft`, `uploading`, `processing`, `ready`, `failed` (per `phase-03-videos/TD-10`) |
| storage_key | varchar | not null — object key of the source file (per `phase-03-videos/TD-05`) |
| thumbnail_key | varchar | nullable — object key of the generated thumbnail; null until processing succeeds |
| upload_id | varchar | nullable — S3 multipart upload ID; held while `status = uploading`, cleared on complete/abort (per `phase-03-videos/TD-02`) |
| declared_size_bytes | bigint | nullable — size declared by the client at init, used by the admission check (per `phase-03-videos/TD-12`) |
| declared_mime_type | varchar(128) | nullable — MIME type declared by the client at init (per `phase-03-videos/TD-12`) |
| duration_seconds | integer | nullable — extracted by `ffprobe`; null until processing succeeds |
| metadata | jsonb | nullable — normalized `ffprobe` subset; null until processing succeeds |
| processing_error | text | nullable — terminal error message, set only when `status = failed` (per `phase-03-videos/TD-10`) |
| created_at | timestamp | not null, auto-generated (`@CreateDateColumn`) |
| updated_at | timestamp | not null, auto-generated (`@UpdateDateColumn`) |

**Relations:** `Video` → `Channel` (many-to-one via `channel_id`); `Channel` has many `Video`.

**Indexes:** unique on `public_id`; `(channel_id)` — FK and owner-scoped listing; `(status)` — for the abandoned-upload reaper.

**`metadata` JSONB shape** (normalized subset of `ffprobe -print_format json` output — the field set is deliberately held in JSONB rather than discrete columns because it is expected to grow in Fases 04–05 without a migration per field, and normalized rather than stored raw so the schema is not coupled to the tool's output format):

```json
{
  "width": 1920,
  "height": 1080,
  "video_codec": "h264",
  "audio_codec": "aac",
  "container": "mov,mp4,m4a,3gp,3g2,mj2",
  "bitrate": 4500000,
  "framerate": 30,
  "size_bytes": 734003200
}
```

`duration_seconds` is a typed column rather than a `metadata` key because it is displayed and sorted on, so it must be queryable.

**Status lifecycle** (per `phase-03-videos/TD-10`):

```
draft ──(init upload)──> uploading ──(complete)──> processing ──> ready
                                                        │
                                                        └──(all queue attempts exhausted)──> failed
```

`draft` means "row pre-registered, no bytes in flight"; `uploading` means "multipart upload initiated". The split is load-bearing: it lets the reaper target abandoned transfers (`uploading` rows older than the cutoff) without touching legitimate drafts, and it keeps `draft` free for the rascunho → publicação semantics Fase 04 introduces. `ready` means "processed" — **not** "published"; publication and público/unlisted visibility arrive in Fase 04.

### API Contracts

All endpoints are under the global JWT guard inherited from `phase-02-auth/TD-02`; none carries `@Public()`. The error envelope is the inherited `{ statusCode, error, message }` shape from `phase-02-auth/TD-07`.

#### POST /videos (SI-03.5)

Initiates an upload: pre-registers the video row as a draft and returns presigned part URLs. The request carries only declared metadata — no bytes (per `phase-03-videos/TD-02`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer &lt;access_token&gt;

**Request body:**
- title: string, required — min 1, max 255 characters
- size_bytes: number, required — integer, min 1, max 10737418240 (10 GiB) (per `phase-03-videos/TD-12`)
- mime_type: string, required — must be in the accepted-formats allowlist (per `phase-03-videos/TD-12`)

**Response 201:**
- public_id: string — the unique URL identifier (per `phase-03-videos/TD-08`)
- status: string — always `uploading` on a successful init
- upload_id: string — the S3 multipart upload ID, echoed back for the complete call
- part_size_bytes: number — the part size the client must use for every part except the last
- parts: array of objects — one entry per part:
  - part_number: number — 1-based, ascending and consecutive
  - url: string — presigned `UploadPart` URL
  - expires_at: string (ISO-8601) — when the presigned URL stops being accepted

**Error responses:**
- 400 VIDEO_SIZE_EXCEEDS_LIMIT: when `size_bytes` is above the 10 GiB ceiling
- 400 VIDEO_MIME_TYPE_NOT_ACCEPTED: when `mime_type` is outside the allowlist
- 400 validation error: when the request body fails schema validation
- 401 (inherited): when the access token is missing or invalid

---

#### POST /videos/:publicId/complete (SI-03.6)

Finalizes the multipart upload, verifies the stored object against the declared size, flips the status and enqueues the processing job (per `phase-03-videos/TD-03`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer &lt;access_token&gt;

**Request body:**
- parts: array of objects, required — min 1 entry; the client's own record of what it uploaded, never a `ListParts` read:
  - part_number: number, required — 1-based
  - etag: string, required — the ETag returned by the corresponding `UploadPart` response

**Response 200:**
- public_id: string
- status: string — always `processing` on success

**Error responses:**
- 400 VIDEO_SIZE_EXCEEDS_LIMIT: when the `HeadObject` check finds the stored object above the ceiling — the object is deleted and the video moves to `failed` (per `phase-03-videos/TD-12`)
- 400 validation error: when the request body fails schema validation
- 401 (inherited): when the access token is missing or invalid
- 403 VIDEO_NOT_OWNED: when the authenticated user does not own the video's channel (per `phase-03-videos/TD-11`)
- 404 VIDEO_NOT_FOUND: when no video matches `publicId`
- 409 VIDEO_INVALID_STATE_TRANSITION: when the video is not in `uploading`

---

#### DELETE /videos/:publicId/upload (SI-03.6)

Aborts an in-flight multipart upload, releasing the parts S3 is billing for, and returns the video to `draft`.

**Request headers:**
- Authorization: Bearer &lt;access_token&gt;

**Response 204:** No content.

**Error responses:**
- 401 (inherited): when the access token is missing or invalid
- 403 VIDEO_NOT_OWNED: when the authenticated user does not own the video's channel
- 404 VIDEO_NOT_FOUND: when no video matches `publicId`
- 409 VIDEO_INVALID_STATE_TRANSITION: when the video is not in `uploading`

---

#### GET /videos/:publicId (SI-03.9)

Reads the video's current state. This is how a client observes the `processing → ready | failed` transition.

**Request headers:**
- Authorization: Bearer &lt;access_token&gt;

**Response 200:**
- public_id: string
- title: string
- status: string — one of `draft`, `uploading`, `processing`, `ready`, `failed`
- duration_seconds: number or null — null until processing succeeds
- metadata: object or null — the normalized `ffprobe` subset (see § Data Model); null until processing succeeds
- thumbnail_url: string or null — short-lived presigned GET URL; null until processing succeeds
- processing_error: string or null — set only when `status` is `failed`
- created_at: string (ISO-8601)

**Error responses:**
- 401 (inherited): when the access token is missing or invalid
- 403 VIDEO_NOT_OWNED: when the authenticated user does not own the video's channel
- 404 VIDEO_NOT_FOUND: when no video matches `publicId`

---

#### GET /videos/:publicId/stream (SI-03.10)

Authorizes the request and redirects to a short-lived presigned GET URL; the storage serves the bytes and implements HTTP `Range` / `206 Partial Content` natively, so playback starts without a full download (per `phase-03-videos/TD-09`).

**Request headers:**
- Authorization: Bearer &lt;access_token&gt;

**Response 302:** `Location` header carrying the presigned GET URL. No body.

**Error responses:**
- 401 (inherited): when the access token is missing or invalid
- 403 VIDEO_NOT_OWNED: when the authenticated user does not own the video's channel
- 404 VIDEO_NOT_FOUND: when no video matches `publicId`
- 409 VIDEO_NOT_READY: when the video's status is not `ready`

---

#### GET /videos/:publicId/download (SI-03.10)

Same authorization and redirect mechanism as `/stream`, with the presigned URL carrying a response-header override so the browser saves the file instead of playing it.

**Request headers:**
- Authorization: Bearer &lt;access_token&gt;

**Response 302:** `Location` header carrying the presigned GET URL, signed with a `response-content-disposition` override of `attachment`. No body.

**Error responses:**
- 401 (inherited): when the access token is missing or invalid
- 403 VIDEO_NOT_OWNED: when the authenticated user does not own the video's channel
- 404 VIDEO_NOT_FOUND: when no video matches `publicId`
- 409 VIDEO_NOT_READY: when the video's status is not `ready`

---

#### Validation Rules — video upload admission

Enforced by the global `ValidationPipe` plus the admission checks from `phase-03-videos/TD-12`:

- `title`: required, string, min 1, max 255 characters
- `size_bytes`: required, integer, min 1, max `10737418240` (10 GiB). Validated against the **declared** value at init; re-verified against the **actual** object via `HeadObject` at completion, because a presigned PUT URL constrains neither size nor content type
- `mime_type`: required, string, must match the accepted-formats allowlist. Re-verified against the real container/codec by the worker's `ffprobe` pass; a mismatch moves the video to `failed`
- `parts[].part_number`: required, integer, ≥ 1, consecutive and ascending starting at 1
- `parts[].etag`: required, non-empty string — sourced from the client's own `UploadPart` response records

### Authorization Matrix

Per `phase-03-videos/TD-11`, every operation in this phase is **owner-only**: the authenticated user must own the channel the video belongs to. Nothing is anonymous and nothing is open to other authenticated users, because in this phase `ready` means "processed", not "published" — publication and público/unlisted visibility arrive in Fase 04, which loosens this matrix rather than retracting access.

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ | ✓ (creates under own channel) | ✓ |
| POST /videos/:publicId/complete | ✗ | ✗ | ✓ |
| DELETE /videos/:publicId/upload | ✗ | ✗ | ✓ |
| GET /videos/:publicId | ✗ | ✗ | ✓ |
| GET /videos/:publicId/stream | ✗ | ✗ | ✓ (and only when `status = ready`) |
| GET /videos/:publicId/download | ✗ | ✗ | ✓ (and only when `status = ready`) |

**Enforcement mechanism.** Authentication comes from the inherited global JWT guard (`phase-02-auth/TD-02`) — no endpoint in this phase carries `@Public()`. Ownership is a **separate check in the service layer**, resolving the video's `channel_id` against the authenticated user's channel; it is deliberately **not** a parallel authorization mechanism bypassing the established guard.

**Granularity caveat (streaming and download).** Per `phase-03-videos/TD-09`, authorization is enforced at the hop that **issues** the presigned URL, not per byte. Once issued, the URL is a bearer token valid until it expires, so the effective rule is "authorized at issuance, bounded by expiry". Presign TTL is therefore the only lever limiting access and must be kept short. Per-request revocation was the advantage of the rejected Option B and is not available here.

**Non-`ready` states are not deliverable.** `/stream` and `/download` reject any video whose status is not `ready` with `409 VIDEO_NOT_READY` — for `draft` the object does not exist, for `uploading` it is incomplete, for `processing` it is unverified, and for `failed` it is unusable.

---

### Error Catalog

Error response shape is inherited from `phase-02-auth/TD-07` and unchanged by this phase:

```
{ statusCode: number, error: string, message: string }
```

The `error` field carries the domain code below; validation failures surface as `error: "VALIDATION_ERROR"` with `message` as an array of field-level strings, per the inherited `ValidationExceptionFilter`.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | Any endpoint addressed with a `publicId` that matches no video row |
| VIDEO_NOT_OWNED | 403 | The authenticated user does not own the channel the video belongs to (per `phase-03-videos/TD-11`) |
| VIDEO_INVALID_STATE_TRANSITION | 409 | `POST /complete` or `DELETE /upload` on a video whose status is not `uploading` (per `phase-03-videos/TD-10`) |
| VIDEO_NOT_READY | 409 | `GET /stream` or `GET /download` on a video whose status is not `ready` |
| VIDEO_SIZE_EXCEEDS_LIMIT | 400 | Declared `size_bytes` above 10 GiB at init, or the `HeadObject` check at completion finding the stored object above the ceiling (per `phase-03-videos/TD-12`) |
| VIDEO_MIME_TYPE_NOT_ACCEPTED | 400 | Declared `mime_type` outside the accepted-formats allowlist (per `phase-03-videos/TD-12`) |
| VIDEO_UPLOAD_COMPLETION_FAILED | 502 | `CompleteMultipartUpload` rejected by the storage (e.g., a part ETag does not match) — the video stays in `uploading` so the client can retry or abort |

**Worker-side failures are not HTTP errors.** When the processing job exhausts its queue attempts, there is no request to respond to: the worker writes `status = failed` and the reason into `processing_error`, which `GET /videos/:publicId` then surfaces. Per `phase-03-videos/TD-10` the attempt count itself stays in BullMQ and is deliberately **not** mirrored into a column.

### Events/Messages

One queue, one job type. Transport is BullMQ 6 over Redis via `@nestjs/bullmq` (per `phase-03-videos/TD-01`); the queue name is the injection token binding producer to consumer.

**Queue:** `video-processing`

#### video-processing.process

**Payload:**

```json
{ "videoId": "uuid", "publicId": "string", "storageKey": "string" }
```

The payload carries identifiers only — never the file, never a presigned URL. The worker resolves the object from `storageKey` with its own credentials, so a job that sits in the queue past any URL's expiry is still processable.

**Producer:** `VideosService` (per `phase-03-videos/TD-01`), enqueued from `POST /videos/:publicId/complete` after `CompleteMultipartUpload` and the `HeadObject` size verification succeed and the row flips to `processing` (per `phase-03-videos/TD-03`).

**Consumer:** `VideoProcessingProcessor` — a `@Processor('video-processing')` class extending `WorkerHost`, running in the separate worker container bootstrapped via `NestFactory.createApplicationContext()` (per `phase-03-videos/TD-06`).

**Trigger:** the upload-completion callback. The API learns the transfer finished only from that explicit client call — there is no storage-side event notification in this phase (per `phase-03-videos/TD-03`, which rejected the MinIO bucket-notification webhook as a later hardening step).

**Delivery semantics:** at-least-once. Job options are `attempts: 3` with `backoff: { type: 'exponential', delay: <ms> }`; only after the final attempt fails does the row become `failed` with the reason in `processing_error` (per `phase-03-videos/TD-10`).

**Idempotency requirement.** Because delivery is at-least-once, `process()` must be safe to run twice on the same `videoId`: re-running `ffprobe` and re-generating the thumbnail overwrite the same deterministic object key (`videos/{publicId}/thumbnail.jpg`, per `phase-03-videos/TD-05`) and re-write the same columns, so a duplicate execution converges rather than duplicating state.

**Event-loop constraint (load-bearing).** A BullMQ worker holds a lock on the job and must renew it while processing; the documented failure mode is that a saturated Node event loop prevents renewal, after which the job is moved back to `waiting` and **re-dispatched to another worker** — i.e. the same video processed twice. This is why `phase-03-videos/TD-07` chose `child_process.spawn`: FFmpeg runs as a separate OS process and the worker merely awaits it, leaving the event loop free to renew the lock across a multi-minute transcode. **Implementations must not move FFmpeg work onto the event loop** (the rejected `ffmpeg.wasm` option would have done exactly that). Worker `concurrency` is set low (1–2) because the work is CPU-bound, not I/O-bound.

---

<!-- phase-a-complete -->

## Dependency Map

```
SI-03.1 (root — deps + config namespaces + env validation)
├── SI-03.2 — depends on SI-03.1 (env vars consumed by the new Compose services)
│   └── SI-03.7 — depends on SI-03.2 (worker service + FFmpeg in the image) + SI-03.4
│       └── SI-03.8 — depends on SI-03.7 (worker + processor) + SI-03.4 (StorageService)
├── SI-03.3 — depends on SI-03.1 (Video entity + migration + VideosModule)
└── SI-03.4 — depends on SI-03.1 (config) + SI-03.2 (Redis + MinIO up for integration tests)

SI-03.3 + SI-03.4
└── SI-03.5 — POST /videos (init upload)
    ├── SI-03.6 — depends on SI-03.5 (row in `uploading` + upload_id) + SI-03.4 (QueueModule)
    │   └── SI-03.11 — depends on SI-03.6 (reuses abortUpload) + SI-03.3 (status index)
    └── SI-03.9 — depends on SI-03.5 (row to read) + SI-03.4 (presign thumbnail)
        └── SI-03.10 — depends on SI-03.9 (ownership guard) + SI-03.8 (only `ready` is deliverable)
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3 (parallel) → SI-03.4 → SI-03.5 → SI-03.6, SI-03.7 (parallel) → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11

**Critical path.** The longest chain is SI-03.1 → SI-03.2 → SI-03.4 → SI-03.7 → SI-03.8 → (SI-03.10), which is the worker/processing spine. The endpoint chain (SI-03.5 → SI-03.6 → SI-03.9) can proceed in parallel with worker bootstrap once SI-03.4 lands, because the producer only needs the queue registration — not a running consumer — to enqueue.

**Cross-cutting note.** SI-03.4 is the widest fan-in point: five SIs depend on it (03.5, 03.6, 03.7, 03.8, 03.9). It is deliberately kept to four technical actions so that fan-in does not become a bottleneck.

---

## Deliverables

- [ ] SI-03.1 — Dependências, namespaces de configuração e validação de env
- [ ] SI-03.2 — Infraestrutura no Compose: Redis, MinIO, bootstrap do bucket e container do worker
- [ ] SI-03.3 — Entidade `Video`, migration e `VideosModule`
- [ ] SI-03.4 — `StorageModule` e `QueueModule`: adaptadores de infraestrutura
- [ ] SI-03.5 — `POST /videos`: início do upload com pré-cadastro do rascunho e partes pré-assinadas
- [ ] SI-03.6 — `POST /complete` e `DELETE /upload`: verificação da conclusão e enfileiramento
- [ ] SI-03.7 — Bootstrap do container do worker e registro do processor
- [ ] SI-03.8 — Processamento FFmpeg: metadados, thumbnail e transições de status
- [ ] SI-03.9 — `GET /videos/:publicId`: leitura do estado do vídeo
- [ ] SI-03.10 — Streaming e download: redirect para URL pré-assinada
- [ ] SI-03.11 — Reaper de uploads abandonados

**Capacidades da fase** (uma linha por bullet de `docs/project-plan.md`):

- [ ] Serviço de armazenamento de arquivos (vídeos e thumbnails) — MinIO no Compose, bucket provisionado, chaves `videos/{publicId}/original` e `videos/{publicId}/thumbnail.jpg`
- [ ] Serviço de processamento em segundo plano (filas) — fila `video-processing` em BullMQ sobre Redis, consumida pelo container `video-worker`
- [ ] Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance — multipart pré-assinado; nenhum byte de vídeo atravessa a API
- [ ] Pré-cadastro automático do vídeo como rascunho ao iniciar o upload — linha criada em `draft` e transicionada a `uploading` no `POST /videos`
- [ ] Processamento automático do vídeo após upload (extração de duração e metadados) — `duration_seconds` e `metadata` preenchidos sem intervenção manual
- [ ] Geração automática de thumbnail a partir de um frame do vídeo — JPEG 1280px via filtro `thumbnail` do FFmpeg
- [ ] URL única por vídeo, sem conflito com outros vídeos — `public_id` de 11 caracteres com constraint unique
- [ ] Reprodução via streaming (sem necessidade de download completo) — `206 Partial Content` servido pelo storage via URL pré-assinada
- [ ] Download do vídeo pelo usuário — mesma entrega com `Content-Disposition: attachment`

**Definition of Done** (per `CLAUDE.md` → Definition of Done (Technical); todo comando roda dentro do container):

- [ ] Suíte unit + integração passa (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Suíte E2E passa (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check passa com código 0 (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passa (`docker compose exec nestjs-api npm run lint`)
- [ ] Migration aplica e reverte (`docker compose exec nestjs-api npm run migration:run` / `migration:revert`)
- [ ] `openapi.json` regenerado refletindo os seis endpoints novos (`docker compose exec nestjs-api npm run openapi:export`)
- [ ] `CLAUDE.md` atualizado com a seção de vídeos — módulo, endpoints, fila/worker e storage, coerente com o código entregue
