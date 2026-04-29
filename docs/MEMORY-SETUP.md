# OpenClaw Memory Setup Guide

**Languages:** [English](./MEMORY-SETUP.md) · [Русский](./MEMORY-SETUP.ru.md) · [中文](./MEMORY-SETUP.zh.md)

OpenClaw ships with a builtin memory engine and supports several alternative backends. This guide covers all options with concrete setup steps for each, with a focus on Unraid homelab deployments.

## Table of Contents

- [TL;DR — which backend should I pick?](#tldr--which-backend-should-i-pick)
- [Option 1: Builtin (default)](#option-1-builtin-default)
- [Option 2: QMD — recommended upgrade](#option-2-qmd--recommended-upgrade)
- [Option 3: Graphiti + FalkorDB or Neo4j](#option-3-graphiti--falkordb-or-neo4j)
  - [Path A: Official Graphiti MCP server (simplest)](#path-a-official-graphiti-mcp-server-simplest)
  - [Path B: Community openclaw-graphiti-memory fork (full hybrid)](#path-b-community-openclaw-graphiti-memory-fork-full-hybrid)
- [Option 4: Cognee — knowledge graph](#option-4-cognee--knowledge-graph)
- [Option 5: Mem0 — auto fact extraction](#option-5-mem0--auto-fact-extraction)
- [Quirks and known bugs](#quirks-and-known-bugs)

---

## TL;DR — which backend should I pick?

| Use case | Backend |
|----------|---------|
| Just started, want to see what works | **Builtin** (default, zero-config) |
| Single-agent homelab, better recall | **QMD** (one-line config change) |
| Multi-agent, want shared knowledge graph | **Graphiti + FalkorDB** (Path A or B) |
| Long-running personal assistant via messengers | **Mem0** (self-hosted) |
| Need entity-relationship reasoning | **Cognee** or **Graphiti** |

For a typical Unraid homelab with one agent: **start with QMD**. If you later want a graph layer with shared facts across multiple agents (each Discord/Telegram/WhatsApp identity = its own agent), add Graphiti via Path A.

---

## Option 1: Builtin (default)

OpenClaw's default memory engine. Per-agent SQLite database + markdown files in the workspace (`MEMORY.md`, `SOUL.md`, `AGENTS.md`). Local vector index for retrieval.

### Pros
- Zero configuration — works out of the box.
- No external services required.
- Persists in `Workspace Path` and `Config Path` volumes (already mounted by this template).

### Cons
- Recall accuracy degrades as history grows.
- Context compaction is aggressive — old facts get pushed out.
- No graph reasoning (similarity only).

### How to verify it's active

Control UI → Config → Raw JSON. If there's no `memory.backend` key, builtin is in use:

```json
{
  "memory": { "backend": "builtin" }
}
```

That's the implicit default. No action needed.

---

## Option 2: QMD — recommended upgrade

QMD (Query Markdown Documents) replaces the builtin indexer with hybrid retrieval (vector + BM25/keyword). Authored by the OpenClaw team; experimental but actively maintained.

### Pros
- Significantly better recall accuracy than builtin.
- Local, free, no external services.
- Can index external markdown paths (Obsidian vault, project docs, session transcripts).
- Self-contained — OpenClaw creates `~/.openclaw/agents/<agentId>/qmd/` and manages lifecycle automatically.

### Cons
- Experimental; see [Quirks](#quirks-and-known-bugs) for known bug #36870.
- Requires an embedding provider (Gemini, OpenAI, or compatible).

### Setup

1. Open Control UI → **Config** tab → **Raw JSON**.
2. Merge this block into the existing config:

   ```json
   {
     "memory": {
       "backend": "qmd",
       "qmd": {
         "searchMode": "search",
         "includeDefaultMemory": true,
         "sessions": { "enabled": true },
         "paths": [
           {
             "name": "obsidian",
             "path": "/home/node/clawd/notes",
             "pattern": "**/*.md"
           }
         ]
       }
     },
     "agents": {
       "defaults": {
         "memorySearch": {
           "enabled": true,
           "sources": ["memory", "sessions"],
           "provider": "gemini",
           "model": "gemini-embedding-001",
           "sync": {
             "onSessionStart": true,
             "watch": true
           }
         }
       }
     }
   }
   ```

3. Save → restart container.

### Embedding provider options

| Provider | `provider` value | `model` example | Notes |
|----------|------------------|-----------------|-------|
| Google Gemini | `gemini` | `gemini-embedding-001` | Recommended; cheapest |
| OpenAI | `openai` | `text-embedding-3-small` | Reliable, ~$0.02/M tokens |
| Custom router | `openai` (with custom baseUrl in `models.providers`) | router-specific | Use if you have LiteLLM/vLLM |

### Indexing external paths

The `paths` array in the config above is optional. Each entry indexes a directory of markdown files. For Unraid users with an Obsidian vault on the array:

1. Add an extra mount in the container template: host `/mnt/user/obsidian-vault` → container `/home/node/clawd/notes`.
2. Reference the container path in `paths[].path`.

QMD will index on first start and keep watching if `agents.defaults.memorySearch.sync.watch=true`.

---

## Option 3: Graphiti + FalkorDB or Neo4j

Graphiti is a Python library that builds a temporal knowledge graph on top of Neo4j or FalkorDB. It extracts entities and relationships from text, tracks how they change over time, and supports semantic + graph queries together.

In a homelab you don't run Graphiti as a library — you run it as a **REST or MCP service** in a container, and have OpenClaw call it.

**Graph backend choice:**

| Backend | RAM | Notes |
|---------|-----|-------|
| FalkorDB | ~256 MB at idle | Redis-based, much lighter, recommended for homelab |
| Neo4j | ~1 GB at idle | Industry standard, more tooling around it |

If you already run FalkorDB on Unraid, point Graphiti at it — see Path A.

### Path A: Official Graphiti MCP server (simplest)

Best for: single OpenClaw instance, want graph memory accessible as a tool.

OpenClaw is also an MCP client — it can consume MCP servers as tool providers. The official `getzep/graphiti` repo ships an MCP server that exposes graph operations as MCP tools.

#### Setup

1. **Stand up Graphiti MCP server.** SSH into Unraid:

   ```bash
   mkdir -p /mnt/user/appdata/graphiti
   cd /mnt/user/appdata/graphiti
   git clone https://github.com/getzep/graphiti.git src
   ```

2. **Configure FalkorDB connection.** If your existing FalkorDB is on the same Unraid host on `:6379`:

   ```bash
   cat > /mnt/user/appdata/graphiti/.env <<EOF
   OPENAI_API_KEY=sk-your-key
   MODEL_NAME=gpt-4.1-mini
   GRAPHITI_BACKEND=falkordb
   FALKORDB_HOST=YOUR-UNRAID-IP
   FALKORDB_PORT=6379
   FALKORDB_DATABASE=openclaw_memory
   EOF
   chmod 600 /mnt/user/appdata/graphiti/.env
   ```

   For a custom-router LLM (LiteLLM, vLLM, etc.) instead of OpenAI:

   ```bash
   echo "OPENAI_BASE_URL=https://your-router.example/v1" >> /mnt/user/appdata/graphiti/.env
   ```

3. **Start the MCP server only** (skip the bundled FalkorDB since you have one):

   ```bash
   cd src/mcp_server
   # Edit docker-compose.yml: comment out the falkordb service since you have your own
   # Then start only the mcp-server service:
   docker compose --env-file ../../.env up -d mcp-server
   ```

   MCP server is now on `http://YOUR-UNRAID-IP:8000/mcp/`.

4. **Wire it into OpenClaw.** Control UI → Config → Raw JSON:

   ```json
   {
     "mcpServers": {
       "graphiti": {
         "url": "http://YOUR-UNRAID-IP:8000/mcp/"
       }
     }
   }
   ```

   Save → restart OpenClaw container.

5. **Verify.** In an OpenClaw chat session:

   > List your available memory tools.

   The agent should report Graphiti tools (`search_memory`, `add_episode`, etc.) alongside its native ones.

### Path B: Community openclaw-graphiti-memory fork (full hybrid)

Best for: multiple agents (per-channel personalities), want shared facts across all of them.

This community fork (`clawdbrunner/openclaw-graphiti-memory`) adds a 3-layer architecture:
- **Layer 1**: per-agent QMD (covered above)
- **Layer 2**: shared markdown files symlinked into every agent workspace (`user-profile.md`, `agent-roster.md`, `infrastructure.md`)
- **Layer 3**: shared Graphiti graph queryable by all agents

The original fork uses Neo4j. Below: adapted for Unraid + FalkorDB.

#### Setup

1. **Clone the fork:**

   ```bash
   mkdir -p /mnt/user/appdata/graphiti
   cd /mnt/user/appdata/graphiti
   git clone https://github.com/clawdbrunner/openclaw-graphiti-memory.git src
   ```

2. **Adapt docker-compose.yml.** Edit `src/docker-compose.yml`:

   ```yaml
   services:
     graphiti-api:
       image: zepai/graphiti-api:latest  # or build from src/graphiti
       ports:
         - "8001:8001"
       environment:
         - GRAPHITI_BACKEND=falkordb
         - FALKORDB_HOST=YOUR-UNRAID-IP
         - FALKORDB_PORT=6379
         - FALKORDB_DATABASE=openclaw_memory
         - OPENAI_API_KEY=${OPENAI_API_KEY}
         - MODEL_NAME=${MODEL_NAME:-gpt-4.1-mini}
       restart: unless-stopped
   ```

   Remove the `neo4j` service and any `depends_on: neo4j` references.

3. **Start the API:**

   ```bash
   cp src/docker-compose.yml /mnt/user/appdata/graphiti/docker-compose.yml
   cd /mnt/user/appdata/graphiti
   docker compose --env-file .env up -d
   curl http://YOUR-UNRAID-IP:8001/healthcheck
   ```

4. **Configure QMD in OpenClaw** — same as [Option 2](#option-2-qmd--recommended-upgrade) above.

5. **Install shared layer.** SSH on Unraid:

   ```bash
   WS=/mnt/user/appdata/openclaw/workspace
   SRC=/mnt/user/appdata/graphiti/src

   mkdir -p $WS/_shared/bin

   cp $SRC/scripts/graphiti-search.sh $WS/_shared/bin/
   cp $SRC/scripts/graphiti-log.sh $WS/_shared/bin/
   cp $SRC/scripts/graphiti-context.sh $WS/_shared/bin/
   chmod +x $WS/_shared/bin/*.sh

   cp $SRC/shared-files/*.md $WS/_shared/

   sed -i 's|http://localhost:8001|http://YOUR-UNRAID-IP:8001|g' $WS/_shared/bin/*.sh

   for agent_dir in $WS/agents/*/; do
     agent=$(basename "$agent_dir")
     [[ "$agent" == "_shared" || "$agent" == "_template" ]] && continue
     ln -sf $WS/_shared "$agent_dir/shared"
   done
   ```

6. **Patch agent prompts** — tell each agent to use the graphiti scripts:

   ```bash
   python3 $SRC/scripts/patch-shared-memory.py --workspace $WS
   ```

   Or manually copy the memory-tools section from `$SRC/templates/AGENTS.md.example` into each agent's `AGENTS.md`.

7. **Bulk-import existing files** (optional, one-shot):

   ```bash
   cd $SRC
   python3 scripts/graphiti-import-files.py \
     --graphiti-url http://YOUR-UNRAID-IP:8001 \
     --path $WS \
     --pattern '**/*.md'
   ```

8. **(Optional) auto-sync watcher** — runs in background, syncs file changes to Graphiti:

   ```bash
   nohup python3 scripts/graphiti-watch-files.py \
     --graphiti-url http://YOUR-UNRAID-IP:8001 \
     --path $WS \
     > /var/log/graphiti-watch.log 2>&1 &
   ```

   For systemd-style autostart on Unraid, use the User Scripts plugin and add this command to start at array start.

### What you get with Path B

- **QMD**: per-agent vector search in `Config Path/agents/<id>/qmd/`
- **Graphiti graph**: shared facts and entity relationships, queryable by all agents
- **Shared markdown**: `user-profile.md`, `agent-roster.md`, etc — single source of truth, symlinked into every agent

### Cost

OpenAI API calls for entity extraction (~`gpt-4.1-mini` ≈ $0.15 per 1M input tokens). Each imported file = 1-3 LLM calls. Watch mode = call per change. With a custom router that doesn't hit upstream OpenAI, only your router's per-call cost applies.

---

## Option 4: Cognee — knowledge graph

Knowledge graph memory that understands entity relationships, not just similarity. Heavier setup than QMD; not as polished as Graphiti for OpenClaw integration.

### When to pick Cognee over Graphiti

- You already use Cognee for other projects.
- You need stronger ontology/schema definitions than Graphiti's auto-extraction.
- You want a graph DB other than Neo4j/FalkorDB (Cognee supports more).

### Setup outline

1. Run Cognee as a service (`pip install cognee` or Docker image).
2. Expose its API.
3. Configure OpenClaw to call it (currently no first-class integration — needs custom skill or MCP wrapper).

Full setup is beyond this guide; see [Cognee docs](https://docs.cognee.ai).

---

## Option 5: Mem0 — auto fact extraction

Cloud + self-hosted modes. Automatically extracts facts from conversations and stores them long-term.

### When to pick Mem0

- Long-running personal assistant via messengers (WhatsApp/Telegram/Discord).
- Want automatic fact extraction without manually editing markdown.
- OK with vendor lock-in (cloud) or running another service (self-hosted).

### Setup outline

**Cloud:**

1. Sign up at [mem0.ai](https://mem0.ai).
2. Get API key.
3. Configure OpenClaw via custom skill or MCP wrapper.

**Self-hosted:**

1. Run Mem0 server in Docker.
2. Connect a vector store (Qdrant, FalkorDB, etc.).
3. Configure OpenClaw to use the Mem0 API.

OpenClaw doesn't have a built-in Mem0 backend. You'd need to write a thin MCP shim or skill.

---

## Quirks and known bugs

### `openclaw memory search` deletes QMD collections (issue #36870)

**Status:** reported in March 2026; PR `feat/support-qmd-minscore` merged, but verify your container version includes the fix.

**Symptom:** running `openclaw memory search ""` from CLI times out and silently runs `qmd collection remove vault-main` in the background, wiping the index.

**Workaround:** never search with an empty query. If hit, rebuild the index by re-importing.

### `logging.file` is silently ignored (issue #61295)

OpenClaw runtime always writes logs to `/tmp/openclaw/openclaw-YYYY-MM-DD.log` regardless of `logging.file`. This template mounts `/tmp/openclaw` directly to the host so logs persist outside the overlay fs.

### Schema strict mode

OpenClaw refuses to start if any unknown key appears in the config. `logging.maxFiles` is **not** in the schema — only `logging.maxFileBytes`. Archive count is hardcoded at 5.

### Custom providers require `models[]` array

`models.providers.<name>` without an explicit `models: [{id, name, contextWindow, maxTokens}]` array fails schema validation. The discovery you might expect from OpenAI-compatible routers doesn't happen automatically.

### `Custom LLM API Type` is the protocol adapter

This template's `CUSTOM_LLM_API_TYPE` is the protocol adapter (`openai-completions`, `anthropic-messages`, etc.), NOT the model name. Model name goes in `CUSTOM_LLM_MODEL_ID`.

### Auto-restore on config size drop

OpenClaw watches the config file and auto-restores from a hidden backup if it sees a sudden size drop (e.g., reduction from 836 bytes to 2 bytes when our bootstrap writes `{}` as a stub). Not harmful but produces a noisy log line: `Config auto-restored from backup ... size-drop-vs-last-good`.

---

## References

- [OpenClaw memory builtin docs](https://docs.openclaw.ai/concepts/memory-builtin)
- [OpenClaw QMD docs](https://docs.openclaw.ai/concepts/memory-qmd)
- [Graphiti GitHub](https://github.com/getzep/graphiti)
- [Graphiti FalkorDB driver](https://docs.openclaw.ai/api/drivers/falkordb)
- [Community openclaw-graphiti-memory fork](https://github.com/clawdbrunner/openclaw-graphiti-memory)
- [OpenClaw memory masterclass (VelvetShark, 2026-03-05)](https://velvetshark.com/openclaw-memory-masterclass)
- [Advanced memory management in OpenClaw (LumaDock, 2026-02-23)](https://lumadock.com/tutorials/openclaw-advanced-memory-management)
