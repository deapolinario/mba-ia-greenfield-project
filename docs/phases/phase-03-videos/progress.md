# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 9/11 completed

### SI-03.1 — Dependências, namespaces de configuração e validação de env
- **Status:** completed
- **Tests:** 8 passing
- **Observations:**
  - `npm install` deu ERESOLVE: `typeorm` tem peer opcional em `ioredis@^5.0.4`, mas `bullmq@6` aceita `ioredis >=5`, então `^6.0.0` atende ambos — resolvido com `--legacy-peer-deps` (não é bypass de segurança, é conflito de peer opcional).
  - Removi deliberadamente `abandonedUploadCutoffHours` do `storage.config.ts` nesta SI — pertence à SI-03.11 por especificação do plano.
  - Não toquei no bug conhecido do `MAIL_FROM` (aspas quebradas) em `.env.example`/`.env` ao editar essas seções — fora do escopo desta SI.

### SI-03.2 — Infraestrutura no Compose: Redis, MinIO, bootstrap do bucket e container do worker
- **Status:** completed
- **Tests:** no tests (infra)
- **Observations:**
  - `minio/minio` e `minio/mc` foram removidos do Docker Hub pela própria MinIO (pull access denied); `quay.io/minio/*` também retorna 401 mesmo para `latest` anônimo (confirmado que o quay.io em si funciona — outro repo, `quay.io/prometheus/prometheus`, pulled normalmente). Troquei para `bitnamilegacy/minio:latest` e `bitnamilegacy/minio-client:latest` (mirror congelado, mesmo binário upstream, mesmas env vars `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`). Healthcheck do `minio` virou `curl` em vez de `mc ready local` porque a imagem bitnami inclui curl.
  - **AC removida do plano**: a lifecycle rule `AbortIncompleteMultipartUpload` citada em `phase-03-videos/TD-03` não é aplicável — o servidor MinIO rejeita essa ação de lifecycle (`"The XML you provided was not well-formed or did not validate"`), confirmado tanto via `mc ilm rule import` quanto via chamada direta à API S3 com `aws-cli` (`aws s3api put-bucket-lifecycle-configuration`), eliminando hipótese de bug de ferramenta cliente. É limitação documentada do servidor MinIO ([minio/minio#16120](https://github.com/minio/minio/issues/16120)), não desta versão específica. Decisão do usuário: remover a AC e a tentativa do `minio-bootstrap`; a limpeza de upload abandonado fica inteiramente a cargo do reaper em nível de aplicação (SI-03.11), que já era a mitigação funcional real e testável. Em S3 real de produção essa lifecycle rule funcionaria normalmente — é especificamente uma lacuna do MinIO.
  - `MINIO_BROWSER=on` precisou ser setado explicitamente — o default da imagem bitnami é `off`, o que deixaria o console (porta 9001) inacessível.

### SI-03.3 — Entidade `Video`, migration e `VideosModule`
- **Status:** completed
- **Tests:** 10 passing
- **Observations:**
  - Fiz o merge de `feature/ajustes_testes` nesta branch antes de implementar esta SI — a branch não tinha o fix de isolamento de testes (banco `streamtube_test` dedicado), e a entidade `Video` usa um enum Postgres (`status`), o mesmo padrão que causou a flakiness original. Merge sem conflitos; suíte completa (156/156) rodou verde antes e depois.
  - `cleanAllTables` em `create-test-data-source.ts` agora limpa `videos` antes de `channels` (FK), com guarda `to_regclass('public.videos') IS NOT NULL` — necessário porque nem toda suíte inclui a entidade `Video` no seu `DataSource` de teste, então a tabela pode não existir na conexão daquela suíte especifica mesmo existindo fisicamente no banco compartilhado.
  - `migrations.integration-spec.ts` estendido para a terceira migration (`CreateVideos`): tabela esperada subiu de 4 para 5, `DROP TYPE IF EXISTS "videos_status_enum"` adicionado ao `beforeAll` pelo mesmo motivo do enum de `verification_tokens`.

### SI-03.4 — `StorageModule` e `QueueModule`: adaptadores de infraestrutura
- **Status:** completed
- **Tests:** 7 passing
- **Observations:**
  - `@nestjs/bullmq` e `@nestjs/bull-shared` são ESM-only (`"type": "module"` no `package.json` deles), ao contrário do `bullmq` em si (CJS, conforme documentado no `library-refs.md`). O Jest falhava com `SyntaxError: Unexpected token 'export'` ao importar `@nestjs/bullmq`. Adicionado `transformIgnorePatterns: ["node_modules/(?!(@nestjs/bullmq|@nestjs/bull-shared)/)"]` em `package.json` (jest config) e `test/jest-e2e.json` para que o `ts-jest` transforme esses dois pacotes em vez de ignorá-los.
  - `ListMultipartUploadsCommand` do MinIO retorna `Uploads: undefined` (não `[]`) quando não há nenhum multipart upload em andamento — o teste de `abortMultipartUpload` precisou normalizar com `?? []` antes do `.some()`.
  - `StorageService` expõe os construtores de chave (`buildStorageKey`/`buildThumbnailKey`) como métodos da própria service, não como constantes separadas — são determinísticos mas dependem do `publicId` em runtime, então não cabem em `*.constants.ts`.

### SI-03.5 — `POST /videos`: início do upload com pré-cadastro do rascunho e partes pré-assinadas
- **Status:** completed
- **Tests:** 15 passing (4 unit + 2 integration + 4 e2e novos, mais 5 pré-existentes ajustados)
- **Observations:**
  - Adicionei `ChannelsService.findByUserId(userId)` (nova consulta de DB sem branching) para resolver o canal do usuário autenticado — exigiu injetar `Repository<Channel>` no construtor, o que quebrou a assinatura usada por 8 call sites de teste existentes (`channels.service.spec.ts`, `channels.service.integration-spec.ts`, `users.service.integration-spec.ts`); todos corrigidos para passar o segundo argumento.
  - `npm run test:e2e` não tinha `--runInBand` no script (`package.json`), apesar do `CLAUDE.md` afirmar "already configured". Com um único arquivo e2e isso nunca import ava, mas ao adicionar `videos-upload-init.e2e-spec.ts` os workers paralelos do Jest passaram a colidir no mesmo banco de teste compartilhado (FK violations aleatórias em `channels`/`videos`, e um 409 esperado virando 201). Corrigido adicionando `--runInBand` ao script, conforme a regra do projeto — bug real, não só deste SI.
  - O `@Max(10737418240)` inicialmente colocado no DTO (`size_bytes`) interceptava a validação antes da checagem de domínio do serviço, fazendo o teto de 10 GiB retornar `VALIDATION_ERROR` em vez de `VIDEO_SIZE_EXCEEDS_LIMIT` como o AC exige. Removido do DTO — o teto é checado exclusivamente em `VideosService` contra `uploadMaxSizeBytes`; o DTO só valida forma (`@IsInt`, `@Min(1)`).
  - Os construtores de chave (`buildStorageKey`/`buildThumbnailKey`, da SI-03.4) e o `S3_CLIENT` provider continuam intocados; `VideosService` apenas os consome via `StorageModule` importado.
  - `videos.module.integration-spec.ts` (da SI-03.3) ficou desatualizado nesta SI porque `VideosModule` passou a importar `StorageModule`/`ChannelsModule` — ajustado para registrar `ConfigModule` com `storageConfig` no teste.

### SI-03.6 — `POST /complete` e `DELETE /upload`: verificação da conclusão e enfileiramento
- **Status:** completed
- **Tests:** 36 passing (9 unit + 6 integration novos, 7 e2e novos)
- **Observations:**
  - `POST /:publicId/complete` precisou de `@HttpCode(HttpStatus.OK)` explícito — por default o NestJS responde `201` para `@Post()`, mas o contrato exige `200`.
  - Teste de "tamanho real excede o teto" não aloca um payload de 10 GiB real (inviável em teste). Em vez disso: no teste de integração, construí uma segunda instância de `VideosService` com as mesmas dependências reais (repo/channels/storage/queue) do módulo compilado, mas com um `config` cujo `uploadMaxSizeBytes` é artificialmente pequeno — permite que um PUT real de poucos bytes dispare genuinamente a checagem de `HeadObject`. No e2e, usei `.overrideProvider(storageConfig.KEY)` no `Test.createTestingModule` para baixar o teto só nesse arquivo de teste (51200 bytes), mantendo o `.env` real (10 GiB) intocado para produção e para o e2e de SI-03.5.
  - `VideosService` ganhou `@InjectQueue(VIDEO_PROCESSING_QUEUE)` — `VideosModule` passou a importar `QueueModule` (já registrado globalmente via `AppModule`, mas precisa estar nos imports de `VideosModule` para o provider da fila ficar visível no escopo de injeção do `VideosService`).
  - `findOwnedVideoOrThrow` centraliza a dupla guarda (404 `VIDEO_NOT_FOUND` antes de 403 `VIDEO_NOT_OWNED`) reaproveitada por `completeUpload` e `abortUpload`.
  - `VIDEO_UPLOAD_COMPLETION_FAILED` (502, do Error Catalog) implementado com teste unitário próprio, mesmo não estando entre as 7 ACs explícitas desta SI — é a mesma operação (`completeMultipartUpload`) e o catch já existia por exigência das regras de tratamento de erro do projeto (nunca engolir exceção).

### SI-03.7 — Bootstrap do container do worker e registro do processor
- **Status:** completed
- **Tests:** 2 passing (integration)
- **Observations:**
  - `WorkerModule` precisou registrar `Channel` e `User` em `TypeOrmModule.forFeature` além de `Video` — `autoLoadEntities: true` só carrega entidades já registradas via `forFeature` **dentro da mesma árvore de módulos**, e o `WorkerModule` é uma árvore de DI inteiramente separada da `AppModule`. Sem isso, o builder de metadados do TypeORM falhava ao resolver a relação `Video → Channel → User` com "Entity metadata ... was not found", e o módulo nunca inicializava (todas as tentativas de conexão falhavam e o teste travava indefinidamente em retry).
  - O processor (`VideoProcessingProcessor.process`) é deliberadamente um stub nesta SI — apenas loga o recebimento do job. O processamento real (ffprobe, thumbnail, transições de status) é escopo da SI-03.8; implementá-lo aqui violaria o limite da SI.
  - As 4 ACs desta SI são majoritariamente operacionais (logs do container, comportamento do BullMQ sob falha), não unitárias — a tabela de Tests do plano lista só o teste de `WorkerModule`. Verifiquei as 3 primeiras ACs manualmente: subi o `video-worker` via `docker compose up`, confirmei nos logs que o contexto da aplicação inicia sem nenhum log de servidor HTTP escutando, enfileirei um job manualmente via um script `node -e` usando `bullmq` diretamente contra o Redis do Compose, e confirmei via `getJobCounts` que o job foi consumido e marcado `completed`. A 4ª AC (job volta para `waiting` ao parar o worker em andamento) é uma garantia estrutural do mecanismo de lock do BullMQ, já documentado em `library-refs.md` — não é um comportamento desta implementação específica para re-verificar manualmente.
  - Adicionado `start:worker` ao `package.json` (`nest start --entryFile worker/main.worker --watch`) e o `command` do serviço `video-worker` no Compose passou a rodá-lo (antes ficava ocioso em `tail -f /dev/null`, herdado do `Dockerfile.dev`).

### SI-03.8 — Processamento FFmpeg: metadados, thumbnail e transições de status
- **Status:** completed
- **Tests:** 16 passing (6 unit + 2 integration de FfmpegService com binários reais + 4 integration de VideoProcessingService contra MinIO/Postgres reais, mais 4 outros ajustes de limpeza)
- **Observations:**
  - `FfmpegService.probe`/`generateThumbnail` recebem a URL de origem via `storageService.presignGet` em vez de baixar o arquivo para disco — confirmei manualmente que `ffprobe`/`ffmpeg` desta imagem (`--enable-https`, `--enable-gnutls`) leem direto de uma URL HTTP(S) presignada do MinIO. Isso evita bufferizar arquivos de até 10 GiB no disco do worker; só o thumbnail (poucos KB) é materializado localmente antes do upload.
  - Nenhum fixture binário foi commitado ao repo. Os testes de integração geram um vídeo sintético curto on-the-fly com o próprio `ffmpeg` (`color=black` 1s concatenado com `testsrc` 1s, h264/aac/mp4) — isso também permite a AC "thumbnail não é frame preto" ser verificada de forma determinística (o primeiro frame real é preto; o filtro `thumbnail` deve escolher o segundo). Verifiquei via `ffmpeg -vf signalstats` que o thumbnail gerado tem luma média (YAVG) bem acima de zero, confirmando que não é o frame preto.
  - A checagem container-vs-MIME (`container-mime.util.ts`) reconhece que `video/mp4`↔`video/quicktime` compartilham o mesmo `format_name` do ffprobe (ambos ISO BMFF) e `video/webm`↔`video/x-matroska` idem (WebM é um perfil do Matroska) — não é uma aproximação, é a relação real entre esses containers; uma checagem 1:1 ingênua teria falsos positivos de "mismatch" para arquivos legítimos.
  - Descoberta corrigida nesta SI: `QueueModule` nunca configurava `attempts`/`backoff` no `BullModule.forRootAsync` (`defaultJobOptions`), apesar do Events/Messages do plano já descrever esse comportamento desde a SI-03.6. Sem isso, `job.opts.attempts` seria `undefined` e a lógica de "só falha definitivamente na última tentativa" desta SI não teria base para funcionar. Adicionado `defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }`.
  - Tentei verificar a AC "concluído um upload válido, o vídeo chega a ready sem intervenção manual" manualmente via `docker compose up` + chamadas HTTP reais, mas o banco de dev (`streamtube`) tem as tabelas `channels`/`users` órfãs de antes da introdução de migrations (criadas via `synchronize`, sem entrada correspondente na tabela `migrations`) — `npm run migration:run` falha com "relation already exists". Isso é débito pré-existente, não relacionado a esta SI (nunca rodei `migration:run` contra o banco de dev real nas SIs anteriores, só contra o banco de teste isolado). Não tentei corrigir — dropar tabelas de um banco de dev persistente não é uma decisão para tomar sem o usuário. O teste de integração automatizado (`video-processing.service.integration-spec.ts`) já cobre a mesma AC com evidência mais forte, pois roda contra o schema gerado pelas migrations reais.
  - `VideoProcessingService.process` recebe o `Job` inteiro (não só o payload) porque precisa de `job.attemptsMade`/`job.opts.attempts` para decidir se é a tentativa final — isso é lido, nunca persistido em coluna, conforme TD-10.

### SI-03.9 — `GET /videos/:publicId`: leitura do estado do vídeo
- **Status:** completed
- **Tests:** 13 passing (6 integration novos de `findByPublicIdForOwner`, 7 e2e novos)
- **Observations:**
  - `thumbnail_url` só é pré-assinado quando `status === 'ready'` e `thumbnail_key` está presente — nos demais estados (incluindo `failed`, onde `thumbnail_key` já é nulo por construção da SI-03.8) a resposta expõe `null`, satisfazendo as ACs sem lógica extra.
  - `findByPublicIdForOwner` reaproveita o helper privado `findOwnedVideoOrThrow` já existente (SI-03.6), que já fazia a dupla guarda 404→403 — nenhuma duplicação de lógica de autorização.
  - Teste e2e do caminho `ready` sobe um JPEG real (poucos bytes) no MinIO e busca a `thumbnail_url` retornada via `fetch` real, confirmando `Content-Type: image/*` — não apenas que a URL tem formato de string.

### SI-03.10 — Streaming e download: redirect para URL pré-assinada
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Reaper de uploads abandonados
- **Status:** pending
- **Tests:** —
- **Observations:** none
