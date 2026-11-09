# AGENTS.md

zcode-proxy — a local proxy that exposes Z.AI / Bigmodel GLM coding plans through OpenAI- and Anthropic-compatible endpoints. Bun + TypeScript, single package.

## Commands

- `bun test` — run the full test suite
- `bun test src/auth/` — run one directory's tests
- `bun run dev` — run the proxy from source
- `docker compose up -d --build` — build & run the containerized proxy (reads `.env` for `ZCODE_PROXY_API_KEY` / `ZCODE_PROXY_CREDENTIAL_SECRET`)

## Agent skills

### Issue tracker

GitHub Issues via `gh` CLI (repo longphamdev/zcode-api). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles, label strings equal to role names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
