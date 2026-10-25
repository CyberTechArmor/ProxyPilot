# Selected stack baseline

Baseline `cpr-2026-10-03`; reviewed 2026-10-03; next review 2026-11-03.

Generated from `stack.versions.json`. Exact selected versions are defaults for new PRO applications; existing stacks retain their recorded lines under the patch policy. See `Stack-Versions.md` for compatibility evidence and scope.

| System | Selected version | Channel | Applicability |
| --- | --- | --- | --- |
| node | 24.21.0 | LTS | PRO baseline |
| npm | 12.2.0 | stable | PRO baseline |
| postgresql | 18.6 | stable | PRO baseline |
| pgvector | 0.8.7 | stable | PRO baseline |
| react | 19.3.0 | stable | PRO baseline |
| react-dom | 19.3.0 | stable | PRO baseline |
| typescript | 7.0.2 | stable | PRO baseline |
| express | 5.2.1 | stable | PRO baseline |
| zod | 4.6.5 | stable | PRO baseline |
| drizzle-orm | 0.45.3 | stable | PRO baseline |
| drizzle-kit | 0.31.11 | stable | PRO baseline |
| drizzle-zod | 0.8.3 | stable | When used |
| vite | 8.3.2 | stable | PRO baseline |
| vitest | 5.0.3 | stable | PRO baseline |
| playwright | 1.63.0 | stable | PRO baseline |
| tailwindcss | 4.3.3 | stable | When used |
| shadcn | 4.21.1 | stable | When used |
| nx | 23.2.1 | stable | When used |
| docker-engine | 29.8.2 | stable | PRO baseline |
| docker-compose | 5.6.0 | stable | PRO baseline |
| nginx | 1.30.5 | stable | When used |
| lucide-react | 1.51.0 | stable | When used |
| @electric-sql/pglite | 0.5.8 | stable | When used |
| supertest | 7.3.1 | stable | When used |
| esbuild | 0.28.2 | stable | When used |
| qdrant | 1.19.1 | stable | When used |
| @types/node | 24.19.1 | stable | PRO baseline |
| @types/express | 5.0.6 | stable | PRO baseline |
| @types/react | 19.3.0 | stable | PRO baseline |
| @types/react-dom | 19.3.0 | stable | PRO baseline |
| pg | 8.23.1 | stable | When used |
| @types/pg | 8.23.1 | stable | When used |
| eslint | 10.13.0 | stable | When used |
| seaweedfs | 4.48 | stable | PRO baseline |
| text-embeddings-inference | 1.9.4 | stable | PRO baseline |
| local-embedding-model | BAAI/bge-small-en-v1.5 | stable | PRO baseline |
| openai-embeddings | text-embedding-3-small | stable | When used |

## Compatibility evidence

- `cpr-2026-10-03-packages`: **verified-package-fixture**. Node runtime, React SSR/Vite, Express/Zod request validation, Drizzle SQL/vector mapping, strict TypeScript, Vitest; production DB/storage/browser remain host-specific
- `drizzle-zod-0.8.3-generated`: **verified-package-fixture**. drizzle-zod 0.8.3 in the contracts the generators write, with the selected packages (drizzle-orm 0.45.3, Zod 4.6.5, native TypeScript 7.0.2, Express 5.2.1, React 19.3.0, Vite 8.3.2, Vitest 5.0.3, Playwright 1.63.0) and again with drizzle-orm 0.45.4 / Zod 4.6.7 / TypeScript 5.9.3: tsc clean, the generated Vitest request tests passing on the fakes, vite build, Playwright states capture; no PostgreSQL server, migration or query, Node 22 not 24, chromium only
- `foundation-stack-2026-10-24`: **pending-evidence**. pgvector/pgvector:0.8.7-pg18, chrislusf/seaweedfs:4.48 and text-embeddings-inference cpu-1.9.4 with BAAI/bge-small-en-v1.5 run as one Compose stack: vector operations, private object put/get/delete, storage off/on, a storage provider switch with a verified copy, an embeddings provider switch with index replacement and missing-credential reporting. Image tags checked to exist on 2026-10-24; no stack run is recorded in this release
- `relay-reference-1.2.1`: **retained-contract**. React 18 / Express 4 / Zod 3 reference adapter; new application major lines need a tested host adapter/port
