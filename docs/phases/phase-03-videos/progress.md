# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 4/11 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — `POST /complete` e `DELETE /upload`: verificação da conclusão e enfileiramento
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Bootstrap do container do worker e registro do processor
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Processamento FFmpeg: metadados, thumbnail e transições de status
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — `GET /videos/:publicId`: leitura do estado do vídeo
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Streaming e download: redirect para URL pré-assinada
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Reaper de uploads abandonados
- **Status:** pending
- **Tests:** —
- **Observations:** none
