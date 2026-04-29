# OpenClaw 记忆功能配置指南

**Languages:** [English](./MEMORY-SETUP.md) · [Русский](./MEMORY-SETUP.ru.md) · [中文](./MEMORY-SETUP.zh.md)

OpenClaw 内置了一套记忆引擎，同时支持多种可替换的记忆后端。本指南涵盖所有可用选项及各自的详细配置步骤，重点面向 Unraid 家庭实验室场景。

## 目录

- [简而言之 —— 该选哪个记忆后端？](#tldr--which-backend-should-i-pick)
- [选项 1：内置后端（默认）](#option-1-builtin-default)
- [选项 2：QMD —— 推荐升级方案](#option-2-qmd--recommended-upgrade)
- [选项 3：Graphiti + FalkorDB 或 Neo4j](#option-3-graphiti--falkordb-or-neo4j)
  - [路径 A：官方 Graphiti MCP 服务器（最简单）](#path-a-official-graphiti-mcp-server-simplest)
  - [路径 B：社区 openclaw-graphiti-memory fork（完整混合架构）](#path-b-community-openclaw-graphiti-memory-fork-full-hybrid)
- [选项 4：Cognee —— 知识图谱后端](#option-4-cognee--knowledge-graph)
- [选项 5：Mem0 —— 自动事实抽取](#option-5-mem0--auto-fact-extraction)
- [怪癖与已知 Bug](#quirks-and-known-bugs)

---

## 简而言之 —— 该选哪个记忆后端？ <a id="tldr--which-backend-should-i-pick"></a>

| 使用场景 | 后端 |
|----------|---------|
| 刚开始使用，想先跑通 | **内置后端**（默认，无需配置） |
| 单 Agent 家庭实验室，想提升召回效果 | **QMD**（改一行配置即可） |
| 多 Agent，需要共享知识图谱 | **Graphiti + FalkorDB**（路径 A 或 B） |
| 通过即时通讯工具运行长期个人助手 | **Mem0**（自托管） |
| 需要实体关系推理 | **Cognee** 或 **Graphiti** |

对于典型的 Unraid 单 Agent 家庭实验室：**从 QMD 开始**。如果后续希望跨多个 Agent 共享知识图谱（每个 Discord/Telegram/WhatsApp 身份对应一个独立 Agent），再通过路径 A 接入 Graphiti。

---

## 选项 1：内置后端（默认） <a id="option-1-builtin-default"></a>

OpenClaw 的默认记忆引擎。每个 Agent 使用独立的 SQLite 数据库，并在工作区中维护 markdown 文件（`MEMORY.md`、`SOUL.md`、`AGENTS.md`）。检索时使用本地向量索引。

### 优点 <a id="pros"></a>
- 零配置 —— 开箱即用。
- 无需任何外部服务。
- 数据持久化在 `Workspace Path` 和 `Config Path` 卷中（本模板已挂载）。

### 缺点 <a id="cons"></a>
- 随着历史记录增长，召回准确率会下降。
- 上下文压缩较为激进 —— 旧事实容易被挤出。
- 不支持图推理（仅支持相似度匹配）。

### 如何验证当前是否使用内置后端

控制面板 → Config → Raw JSON。如果没有 `memory.backend` 键，则当前使用的是内置后端：

```json
{
  "memory": { "backend": "builtin" }
}
```

这是隐式默认值，无需任何操作。

---

## 选项 2：QMD —— 推荐升级方案 <a id="option-2-qmd--recommended-upgrade"></a>

QMD（Query Markdown Documents）用混合检索（向量 + BM25/关键词）替换了内置索引器。由 OpenClaw 团队开发，目前处于实验阶段，但持续维护中。

### 优点
- 召回准确率显著优于内置后端。
- 纯本地运行，免费，无需外部服务。
- 可索引外部 markdown 路径（Obsidian 知识库、项目文档、会话记录等）。
- 自包含 —— OpenClaw 会自动创建 `~/.openclaw/agents/<agentId>/qmd/` 目录并管理其生命周期。

### 缺点
- 实验性功能；已知 Bug #36870，详见[怪癖与已知 Bug](#quirks-and-known-bugs)。
- 需要嵌入提供商（Gemini、OpenAI 或兼容接口）。

### 配置步骤

1. 打开控制面板 → **Config** 标签页 → **Raw JSON**。
2. 将以下配置块合并到现有配置中：

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

3. 保存 → 重启容器。

### 嵌入提供商选项

| 提供商 | `provider` 值 | `model` 示例 | 备注 |
|----------|------------------|-----------------|-------|
| Google Gemini | `gemini` | `gemini-embedding-001` | 推荐；费用最低 |
| OpenAI | `openai` | `text-embedding-3-small` | 稳定可靠，约 $0.02/M tokens |
| 自定义路由 | `openai`（在 `models.providers` 中配置自定义 baseUrl） | 路由器专用 | 适合使用 LiteLLM/vLLM 的场景 |

### 索引外部路径

上述配置中的 `paths` 数组是可选的。每个条目会对一个 markdown 文件目录进行索引。对于在阵列上存有 Obsidian 知识库的 Unraid 用户：

1. 在容器模板中添加额外挂载：宿主机 `/mnt/user/obsidian-vault` → 容器 `/home/node/clawd/notes`。
2. 在 `paths[].path` 中填写容器内的路径。

QMD 会在首次启动时进行索引，若 `agents.defaults.memorySearch.sync.watch=true` 则持续监听文件变化。

---

## 选项 3：Graphiti + FalkorDB 或 Neo4j <a id="option-3-graphiti--falkordb-or-neo4j"></a>

Graphiti 是一个 Python 库，可在 Neo4j 或 FalkorDB 之上构建时序知识图谱。它能从文本中抽取实体和关系、追踪其随时间的演变，并支持语义查询与图查询的联合检索。

在家庭实验室中，Graphiti 不以库的形式运行，而是作为容器中的 **REST 或 MCP 服务**运行，再由 OpenClaw 调用。

**图后端选择：**

| 后端 | 内存占用 | 备注 |
|---------|-----|-------|
| FalkorDB | 空闲时约 256 MB | 基于 Redis，轻量得多，推荐家庭实验室使用 |
| Neo4j | 空闲时约 1 GB | 行业标准，周边工具更丰富 |

如果你已在 Unraid 上运行 FalkorDB，可直接将 Graphiti 指向它 —— 参见路径 A。

### 路径 A：官方 Graphiti MCP 服务器（最简单） <a id="path-a-official-graphiti-mcp-server-simplest"></a>

适用场景：单个 OpenClaw 实例，希望以工具形式访问图记忆。

OpenClaw 同时也是一个 MCP 客户端 —— 它可以将 MCP 服务器作为工具提供方来消费。官方 `getzep/graphiti` 仓库附带了一个 MCP 服务器，将图操作以 MCP 工具的形式对外暴露。

#### 配置步骤

1. **启动 Graphiti MCP 服务器。** 通过 SSH 登录 Unraid：

   ```bash
   mkdir -p /mnt/user/appdata/graphiti
   cd /mnt/user/appdata/graphiti
   git clone https://github.com/getzep/graphiti.git src
   ```

2. **配置 FalkorDB 连接。** 若现有 FalkorDB 在同一 Unraid 主机的 `:6379` 端口：

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

   若使用自定义 LLM 路由器（LiteLLM、vLLM 等）而非 OpenAI：

   ```bash
   echo "OPENAI_BASE_URL=https://your-router.example/v1" >> /mnt/user/appdata/graphiti/.env
   ```

3. **仅启动 MCP 服务器**（跳过捆绑的 FalkorDB，因为你已有自己的实例）：

   ```bash
   cd src/mcp_server
   # 编辑 docker-compose.yml：注释掉 falkordb 服务，因为你已有独立实例
   # 然后仅启动 mcp-server 服务：
   docker compose --env-file ../../.env up -d mcp-server
   ```

   MCP 服务器现在运行在 `http://YOUR-UNRAID-IP:8000/mcp/`。

4. **接入 OpenClaw。** 控制面板 → Config → Raw JSON：

   ```json
   {
     "mcpServers": {
       "graphiti": {
         "url": "http://YOUR-UNRAID-IP:8000/mcp/"
       }
     }
   }
   ```

   保存 → 重启 OpenClaw 容器。

5. **验证。** 在 OpenClaw 会话中输入：

   > List your available memory tools.

   Agent 应在原生工具之外列出 Graphiti 工具（`search_memory`、`add_episode` 等）。

### 路径 B：社区 openclaw-graphiti-memory fork（完整混合架构） <a id="path-b-community-openclaw-graphiti-memory-fork-full-hybrid"></a>

适用场景：多 Agent（每个频道独立人格），希望在所有 Agent 之间共享知识事实。

此社区 fork（`clawdbrunner/openclaw-graphiti-memory`）引入了三层架构：
- **第一层**：每个 Agent 独立的 QMD（详见上文）
- **第二层**：共享 markdown 文件，以软链接方式挂载到每个 Agent 的工作区（`user-profile.md`、`agent-roster.md`、`infrastructure.md`）
- **第三层**：共享的 Graphiti 图，所有 Agent 均可查询

原始 fork 使用 Neo4j。以下为适配 Unraid + FalkorDB 的版本。

#### 配置步骤

1. **克隆 fork：**

   ```bash
   mkdir -p /mnt/user/appdata/graphiti
   cd /mnt/user/appdata/graphiti
   git clone https://github.com/clawdbrunner/openclaw-graphiti-memory.git src
   ```

2. **修改 docker-compose.yml。** 编辑 `src/docker-compose.yml`：

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

   删除 `neo4j` 服务及所有 `depends_on: neo4j` 引用。

3. **启动 API：**

   ```bash
   cp src/docker-compose.yml /mnt/user/appdata/graphiti/docker-compose.yml
   cd /mnt/user/appdata/graphiti
   docker compose --env-file .env up -d
   curl http://YOUR-UNRAID-IP:8001/healthcheck
   ```

4. **在 OpenClaw 中配置 QMD** —— 与[选项 2](#option-2-qmd--recommended-upgrade) 相同。

5. **安装共享层。** 通过 SSH 在 Unraid 上执行：

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

6. **修补 Agent 提示词** —— 指示每个 Agent 使用 graphiti 脚本：

   ```bash
   python3 $SRC/scripts/patch-shared-memory.py --workspace $WS
   ```

   或手动将 `$SRC/templates/AGENTS.md.example` 中的 memory-tools 段落复制到每个 Agent 的 `AGENTS.md` 中。

7. **批量导入现有文件**（可选，一次性操作）：

   ```bash
   cd $SRC
   python3 scripts/graphiti-import-files.py \
     --graphiti-url http://YOUR-UNRAID-IP:8001 \
     --path $WS \
     --pattern '**/*.md'
   ```

8. **（可选）自动同步监听进程** —— 在后台运行，将文件变更同步到 Graphiti：

   ```bash
   nohup python3 scripts/graphiti-watch-files.py \
     --graphiti-url http://YOUR-UNRAID-IP:8001 \
     --path $WS \
     > /var/log/graphiti-watch.log 2>&1 &
   ```

   若需在 Unraid 上实现 systemd 风格的开机自启，可使用 User Scripts 插件，在阵列启动时执行此命令。

### 路径 B 的最终效果

- **QMD**：每个 Agent 在 `Config Path/agents/<id>/qmd/` 中独享向量搜索
- **Graphiti 图**：共享事实与实体关系，所有 Agent 均可查询
- **共享 markdown**：`user-profile.md`、`agent-roster.md` 等 —— 单一事实来源，软链接至每个 Agent 的工作区

### 费用

OpenAI API 调用用于实体抽取（约 `gpt-4.1-mini`，≈ $0.15 / 1M 输入 tokens）。每个导入文件会产生 1～3 次 LLM 调用；监听模式下每次文件变更触发一次调用。若使用不经过上游 OpenAI 的自定义路由器，则只计路由器本身的调用费用。

---

## 选项 4：Cognee —— 知识图谱后端 <a id="option-4-cognee--knowledge-graph"></a>

基于知识图谱的记忆后端，能理解实体关系而不仅仅是相似度。配置比 QMD 复杂，与 OpenClaw 的集成成熟度不如 Graphiti。

### 何时选择 Cognee 而非 Graphiti

- 你已经在其他项目中使用 Cognee。
- 你需要比 Graphiti 自动抽取更严格的本体/模式定义。
- 你希望使用 Neo4j/FalkorDB 以外的图数据库（Cognee 支持更多选项）。

### 配置概要

1. 将 Cognee 作为服务运行（`pip install cognee` 或 Docker 镜像）。
2. 暴露其 API。
3. 配置 OpenClaw 调用它（目前无原生集成 —— 需要自定义 skill 或 MCP wrapper）。

完整配置超出本指南范围，请参阅 [Cognee 文档](https://docs.cognee.ai)。

---

## 选项 5：Mem0 —— 自动事实抽取 <a id="option-5-mem0--auto-fact-extraction"></a>

支持云端与自托管两种模式。能自动从对话中抽取事实并长期存储。

### 何时选择 Mem0

- 通过即时通讯工具（WhatsApp/Telegram/Discord）运行长期个人助手。
- 希望自动抽取事实，无需手动编辑 markdown。
- 可接受供应商锁定（云端）或自行运维另一个服务（自托管）。

### 配置概要

**云端：**

1. 在 [mem0.ai](https://mem0.ai) 注册账号。
2. 获取 API Key。
3. 通过自定义 skill 或 MCP wrapper 配置 OpenClaw 调用。

**自托管：**

1. 在 Docker 中运行 Mem0 服务器。
2. 连接向量存储（Qdrant、FalkorDB 等）。
3. 配置 OpenClaw 使用 Mem0 API。

OpenClaw 目前没有内置的 Mem0 记忆后端，需要编写一个轻量级的 MCP shim 或 skill。

---

## 怪癖与已知 Bug <a id="quirks-and-known-bugs"></a>

### `openclaw memory search` 会删除 QMD 集合（issue #36870）

**状态：** 于 2026 年 3 月报告；PR `feat/support-qmd-minscore` 已合并，但请确认你的容器版本包含此修复。

**症状：** 从 CLI 执行 `openclaw memory search ""` 时，命令超时，并在后台静默执行 `qmd collection remove vault-main`，从而清除整个索引。

**临时解决方案：** 不要使用空查询搜索。若已触发，可通过重新导入来重建索引。

### `logging.file` 被静默忽略（issue #61295）

OpenClaw 运行时始终将日志写入 `/tmp/openclaw/openclaw-YYYY-MM-DD.log`，无论 `logging.file` 如何配置。本模板将 `/tmp/openclaw` 直接挂载到宿主机，确保日志在 overlay fs 之外持久化。

### 严格模式 Schema 校验

若配置中出现任何未知键，OpenClaw 将拒绝启动。`logging.maxFiles` **不在** schema 中 —— 只有 `logging.maxFileBytes`。归档数量硬编码为 5。

### 自定义提供商需要 `models[]` 数组

`models.providers.<name>` 如果没有显式的 `models: [{id, name, contextWindow, maxTokens}]` 数组，会导致 schema 校验失败。你可能期望从 OpenAI 兼容路由器中自动发现模型列表，但这不会自动发生。

### `Custom LLM API Type` 是协议适配器

本模板的 `CUSTOM_LLM_API_TYPE` 是协议适配器（`openai-completions`、`anthropic-messages` 等），**不是**模型名称。模型名称填写在 `CUSTOM_LLM_MODEL_ID` 中。

### 配置文件大小骤降时自动恢复

OpenClaw 会监听配置文件变化，若检测到文件大小骤降（例如，bootstrap 脚本将 836 字节的配置覆写为 2 字节的 `{}`），会自动从隐藏备份中恢复。此行为无害，但会产生一行噪音日志：`Config auto-restored from backup ... size-drop-vs-last-good`。

---

## 参考资料

- [OpenClaw 内置记忆文档](https://docs.openclaw.ai/concepts/memory-builtin)
- [OpenClaw QMD 文档](https://docs.openclaw.ai/concepts/memory-qmd)
- [Graphiti GitHub](https://github.com/getzep/graphiti)
- [Graphiti FalkorDB 驱动](https://docs.openclaw.ai/api/drivers/falkordb)
- [社区 openclaw-graphiti-memory fork](https://github.com/clawdbrunner/openclaw-graphiti-memory)
- [OpenClaw 记忆功能深度解析（VelvetShark，2026-03-05）](https://velvetshark.com/openclaw-memory-masterclass)
- [OpenClaw 进阶记忆管理（LumaDock，2026-02-23）](https://lumadock.com/tutorials/openclaw-advanced-memory-management)
