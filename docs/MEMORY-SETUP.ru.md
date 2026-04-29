# Руководство по настройке памяти OpenClaw

**Languages:** [English](./MEMORY-SETUP.md) · [Русский](./MEMORY-SETUP.ru.md) · [中文](./MEMORY-SETUP.zh.md)

OpenClaw поставляется со встроенным движком памяти и поддерживает несколько альтернативных бэкендов. Руководство охватывает все варианты с конкретными шагами настройки для каждого — с упором на домашние лабораторные развёртывания на Unraid.

## Содержание

- [Кратко — какой бэкенд выбрать?](#tldr--which-backend-should-i-pick)
- [Вариант 1: Встроенный (по умолчанию)](#option-1-builtin-default)
- [Вариант 2: QMD — рекомендуемый апгрейд](#option-2-qmd--recommended-upgrade)
- [Вариант 3: Graphiti + FalkorDB или Neo4j](#option-3-graphiti--falkordb-or-neo4j)
  - [Путь A: Официальный MCP-сервер Graphiti (проще всего)](#path-a-official-graphiti-mcp-server-simplest)
  - [Путь B: Форк сообщества openclaw-graphiti-memory (полная гибридная схема)](#path-b-community-openclaw-graphiti-memory-fork-full-hybrid)
- [Вариант 4: Cognee — граф знаний](#option-4-cognee--knowledge-graph)
- [Вариант 5: Mem0 — автоматическое извлечение фактов](#option-5-mem0--auto-fact-extraction)
- [Особенности и известные ошибки](#quirks-and-known-bugs)

---

## Кратко — какой бэкенд выбрать? <a id="tldr--which-backend-should-i-pick"></a>

| Сценарий | Бэкенд |
|----------|---------|
| Только начинаю, хочу посмотреть что работает | **Builtin** (по умолчанию, не требует настройки) |
| Одноагентная домашняя лаборатория, нужно лучшее воспроизведение | **QMD** (одна строка в конфиге) |
| Несколько агентов, нужен общий граф знаний | **Graphiti + FalkorDB** (Путь A или B) |
| Долгоживущий личный ассистент через мессенджеры | **Mem0** (self-hosted) |
| Нужны рассуждения по связям между сущностями | **Cognee** или **Graphiti** |

Для типичной домашней лаборатории на Unraid с одним агентом — **начни с QMD**. Если позже понадобится графовый слой с общими фактами между несколькими агентами (каждый аккаунт Discord/Telegram/WhatsApp — отдельный агент), добавь Graphiti через Путь A.

---

## Вариант 1: Встроенный (по умолчанию) <a id="option-1-builtin-default"></a>

Стандартный движок памяти OpenClaw. База данных SQLite на каждого агента + markdown-файлы в рабочем пространстве (`MEMORY.md`, `SOUL.md`, `AGENTS.md`). Для поиска используется локальный векторный индекс.

### Плюсы <a id="pros"></a>
- Нулевая конфигурация — работает из коробки.
- Не требует внешних сервисов.
- Данные сохраняются в томах `Workspace Path` и `Config Path` (уже подключены этим шаблоном).

### Минусы <a id="cons"></a>
- Точность воспроизведения падает по мере роста истории.
- Компактирование контекста агрессивное — старые факты вытесняются.
- Граф не поддерживается (только семантическое сходство).

### Как убедиться, что бэкенд активен

Control UI → Config → Raw JSON. Если ключа `memory.backend` нет — используется встроенный бэкенд:

```json
{
  "memory": { "backend": "builtin" }
}
```

Это неявное значение по умолчанию. Никаких действий не требуется.

---

## Вариант 2: QMD — рекомендуемый апгрейд <a id="option-2-qmd--recommended-upgrade"></a>

QMD (Query Markdown Documents) заменяет встроенный индексатор гибридным поиском (вектор + BM25/ключевые слова). Разработка команды OpenClaw; статус — экспериментальный, активно поддерживается.

### Плюсы
- Заметно лучшая точность воспроизведения по сравнению со встроенным бэкендом.
- Локальный, бесплатный, не требует внешних сервисов.
- Умеет индексировать внешние markdown-пути (хранилище Obsidian, документация проекта, транскрипты сессий).
- Самодостаточный — OpenClaw сам создаёт `~/.openclaw/agents/<agentId>/qmd/` и управляет жизненным циклом.

### Минусы
- Экспериментальный; см. раздел [Особенности и известные ошибки](#quirks-and-known-bugs) по ошибке № 36870.
- Требует провайдера эмбеддингов (Gemini, OpenAI или совместимый).

### Настройка

1. Открой Control UI → вкладку **Config** → **Raw JSON**.
2. Влей этот блок в существующий конфиг:

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

3. Сохрани → перезапусти контейнер.

### Варианты провайдеров эмбеддингов

| Провайдер | Значение `provider` | Пример `model` | Примечания |
|----------|------------------|-----------------|-------|
| Google Gemini | `gemini` | `gemini-embedding-001` | Рекомендуется; самый дешёвый |
| OpenAI | `openai` | `text-embedding-3-small` | Надёжный, ~$0.02 за 1M токенов |
| Собственный роутер | `openai` (с кастомным baseUrl в `models.providers`) | зависит от роутера | Используй, если есть LiteLLM/vLLM |

### Индексация внешних путей

Массив `paths` в конфиге выше — необязательный. Каждый элемент индексирует каталог с markdown-файлами. Пользователям Unraid с хранилищем Obsidian на массиве:

1. Добавь дополнительное монтирование в шаблон контейнера: хост `/mnt/user/obsidian-vault` → контейнер `/home/node/clawd/notes`.
2. Укажи путь контейнера в `paths[].path`.

QMD проиндексирует файлы при первом запуске и будет следить за изменениями, если `agents.defaults.memorySearch.sync.watch=true`.

---

## Вариант 3: Graphiti + FalkorDB или Neo4j <a id="option-3-graphiti--falkordb-or-neo4j"></a>

Graphiti — Python-библиотека, которая строит темпоральный граф знаний поверх Neo4j или FalkorDB. Извлекает сущности и связи из текста, отслеживает их изменения во времени и поддерживает одновременно семантические и графовые запросы.

В домашней лаборатории Graphiti запускают не как библиотеку, а как **REST- или MCP-сервис** в контейнере, к которому обращается OpenClaw.

**Выбор графового бэкенда:**

| Бэкенд | ОЗУ | Примечания |
|---------|-----|-------|
| FalkorDB | ~256 МБ в простое | Основан на Redis, рекомендуется для домашней лаборатории |
| Neo4j | ~1 ГБ в простое | Отраслевой стандарт, больше инструментов вокруг него |

Если FalkorDB уже запущен на Unraid — укажи Graphiti на него, используя Путь A.

### Путь A: Официальный MCP-сервер Graphiti (проще всего) <a id="path-a-official-graphiti-mcp-server-simplest"></a>

Подходит для: одного экземпляра OpenClaw, когда граф памяти нужен как инструмент.

OpenClaw — ещё и MCP-клиент: умеет подключать MCP-серверы как провайдеров инструментов. Официальный репозиторий `getzep/graphiti` поставляет MCP-сервер, который предоставляет графовые операции как MCP-инструменты.

#### Настройка

1. **Разверни MCP-сервер Graphiti.** Подключись к Unraid по SSH:

   ```bash
   mkdir -p /mnt/user/appdata/graphiti
   cd /mnt/user/appdata/graphiti
   git clone https://github.com/getzep/graphiti.git src
   ```

2. **Настрой подключение к FalkorDB.** Если существующий FalkorDB находится на том же хосте Unraid на порту `:6379`:

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

   Для кастомного роутера LLM (LiteLLM, vLLM и др.) вместо OpenAI:

   ```bash
   echo "OPENAI_BASE_URL=https://your-router.example/v1" >> /mnt/user/appdata/graphiti/.env
   ```

3. **Запусти только MCP-сервер** (пропусти встроенный FalkorDB, раз он уже есть):

   ```bash
   cd src/mcp_server
   # Отредактируй docker-compose.yml: закомментируй сервис falkordb, раз он уже есть
   # Затем запусти только сервис mcp-server:
   docker compose --env-file ../../.env up -d mcp-server
   ```

   MCP-сервер теперь доступен по адресу `http://YOUR-UNRAID-IP:8000/mcp/`.

4. **Подключи к OpenClaw.** Control UI → Config → Raw JSON:

   ```json
   {
     "mcpServers": {
       "graphiti": {
         "url": "http://YOUR-UNRAID-IP:8000/mcp/"
       }
     }
   }
   ```

   Сохрани → перезапусти контейнер OpenClaw.

5. **Проверь.** В сессии чата OpenClaw:

   > List your available memory tools.

   Агент должен сообщить об инструментах Graphiti (`search_memory`, `add_episode` и др.) наряду со своими нативными инструментами.

### Путь B: Форк сообщества openclaw-graphiti-memory (полная гибридная схема) <a id="path-b-community-openclaw-graphiti-memory-fork-full-hybrid"></a>

Подходит для: нескольких агентов (разные личности в разных каналах), когда нужны общие факты между ними.

Форк сообщества (`clawdbrunner/openclaw-graphiti-memory`) реализует трёхуровневую архитектуру:
- **Уровень 1**: QMD на каждого агента (описан выше)
- **Уровень 2**: общие markdown-файлы, симлинкованные в рабочее пространство каждого агента (`user-profile.md`, `agent-roster.md`, `infrastructure.md`)
- **Уровень 3**: общий граф Graphiti, доступный для запросов всем агентам

Оригинальный форк использует Neo4j. Ниже — адаптация для Unraid + FalkorDB.

#### Настройка

1. **Клонируй форк:**

   ```bash
   mkdir -p /mnt/user/appdata/graphiti
   cd /mnt/user/appdata/graphiti
   git clone https://github.com/clawdbrunner/openclaw-graphiti-memory.git src
   ```

2. **Адаптируй docker-compose.yml.** Отредактируй `src/docker-compose.yml`:

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

   Удали сервис `neo4j` и все ссылки `depends_on: neo4j`.

3. **Запусти API:**

   ```bash
   cp src/docker-compose.yml /mnt/user/appdata/graphiti/docker-compose.yml
   cd /mnt/user/appdata/graphiti
   docker compose --env-file .env up -d
   curl http://YOUR-UNRAID-IP:8001/healthcheck
   ```

4. **Настрой QMD в OpenClaw** — аналогично [Варианту 2](#option-2-qmd--recommended-upgrade) выше.

5. **Установи общий слой.** Через SSH на Unraid:

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

6. **Обнови промпты агентов** — укажи каждому агенту использовать скрипты Graphiti:

   ```bash
   python3 $SRC/scripts/patch-shared-memory.py --workspace $WS
   ```

   Или вручную скопируй секцию memory-tools из `$SRC/templates/AGENTS.md.example` в `AGENTS.md` каждого агента.

7. **Массовый импорт существующих файлов** (опционально, однократно):

   ```bash
   cd $SRC
   python3 scripts/graphiti-import-files.py \
     --graphiti-url http://YOUR-UNRAID-IP:8001 \
     --path $WS \
     --pattern '**/*.md'
   ```

8. **(Опционально) наблюдатель для автосинхронизации** — работает в фоне, синхронизирует изменения файлов с Graphiti:

   ```bash
   nohup python3 scripts/graphiti-watch-files.py \
     --graphiti-url http://YOUR-UNRAID-IP:8001 \
     --path $WS \
     > /var/log/graphiti-watch.log 2>&1 &
   ```

   Для автозапуска в стиле systemd на Unraid используй плагин User Scripts и добавь эту команду на старт массива.

### Что получается при использовании Пути B

- **QMD**: векторный поиск на каждого агента в `Config Path/agents/<id>/qmd/`
- **Граф Graphiti**: общие факты и связи между сущностями, доступные для запросов всем агентам
- **Общие markdown-файлы**: `user-profile.md`, `agent-roster.md` и др. — единый источник истины, симлинкованный в каждого агента

### Стоимость

Вызовы OpenAI API для извлечения сущностей (~`gpt-4.1-mini` ≈ $0.15 за 1M входных токенов). Каждый импортируемый файл — 1–3 вызова LLM. Режим слежения — один вызов на каждое изменение. Если используешь собственный роутер, который не обращается к OpenAI напрямую, — платишь только за вызов своего роутера.

---

## Вариант 4: Cognee — граф знаний <a id="option-4-cognee--knowledge-graph"></a>

Память на основе графа знаний, которая понимает связи между сущностями, а не только семантическое сходство. Настройка сложнее, чем у QMD; интеграция с OpenClaw менее отполирована, чем у Graphiti.

### Когда выбрать Cognee вместо Graphiti

- Ты уже используешь Cognee в других проектах.
- Нужны более жёсткие определения онтологии/схемы, чем даёт автоизвлечение Graphiti.
- Нужна графовая БД, отличная от Neo4j/FalkorDB (Cognee поддерживает больше вариантов).

### Схема настройки

1. Запусти Cognee как сервис (`pip install cognee` или Docker-образ).
2. Открой его API.
3. Настрой OpenClaw на обращение к нему (готовой интеграции нет — потребуется кастомный скилл или MCP-обёртка).

Полная настройка — за пределами этого руководства; см. [документацию Cognee](https://docs.cognee.ai).

---

## Вариант 5: Mem0 — автоматическое извлечение фактов <a id="option-5-mem0--auto-fact-extraction"></a>

Облачный и self-hosted режимы. Автоматически извлекает факты из разговоров и хранит их долгосрочно.

### Когда выбрать Mem0

- Долгоживущий личный ассистент через мессенджеры (WhatsApp/Telegram/Discord).
- Нужно автоматическое извлечение фактов без ручного редактирования markdown.
- Приемлема привязка к вендору (облако) или запуск ещё одного сервиса (self-hosted).

### Схема настройки

**Облако:**

1. Зарегистрируйся на [mem0.ai](https://mem0.ai).
2. Получи API-ключ.
3. Настрой OpenClaw через кастомный скилл или MCP-обёртку.

**Self-hosted:**

1. Запусти сервер Mem0 в Docker.
2. Подключи векторное хранилище (Qdrant, FalkorDB и др.).
3. Настрой OpenClaw на использование Mem0 API.

Встроенного бэкенда Mem0 в OpenClaw нет. Понадобится написать тонкую MCP-обёртку или скилл.

---

## Особенности и известные ошибки <a id="quirks-and-known-bugs"></a>

### `openclaw memory search` удаляет коллекции QMD (issue № 36870)

**Статус:** зафиксировано в марте 2026; PR `feat/support-qmd-minscore` слит, но убедись, что версия твоего контейнера включает это исправление.

**Симптом:** запуск `openclaw memory search ""` из CLI завершается по таймауту и молча выполняет `qmd collection remove vault-main` в фоне, уничтожая индекс.

**Обходной путь:** никогда не ищи с пустым запросом. Если это всё же произошло — восстанови индекс повторным импортом.

### `logging.file` молча игнорируется (issue № 61295)

Среда выполнения OpenClaw всегда пишет логи в `/tmp/openclaw/openclaw-YYYY-MM-DD.log` независимо от значения `logging.file`. Этот шаблон монтирует `/tmp/openclaw` напрямую на хост, чтобы логи сохранялись за пределами оверлейной ФС.

### Строгий режим схемы

OpenClaw отказывается стартовать, если в конфиге обнаруживается неизвестный ключ. `logging.maxFiles` **отсутствует** в схеме — есть только `logging.maxFileBytes`. Количество архивных файлов захардкожено равным 5.

### Кастомные провайдеры требуют массива `models[]`

`models.providers.<name>` без явного массива `models: [{id, name, contextWindow, maxTokens}]` не проходит валидацию схемы. Автообнаружение, которого можно было бы ожидать от OpenAI-совместимых роутеров, здесь не работает.

### `Custom LLM API Type` — это адаптер протокола

`CUSTOM_LLM_API_TYPE` в этом шаблоне — адаптер протокола (`openai-completions`, `anthropic-messages` и др.), а **не** имя модели. Имя модели указывается в `CUSTOM_LLM_MODEL_ID`.

### Автовосстановление при уменьшении размера конфига

OpenClaw следит за файлом конфига и автоматически восстанавливает его из скрытой резервной копии, если видит резкое уменьшение размера (например, с 836 байт до 2 байт, когда наш bootstrap записывает `{}` как заглушку). Это не опасно, но оставляет шумную строку в логе: `Config auto-restored from backup ... size-drop-vs-last-good`.

---

## Ссылки

- [Документация встроенной памяти OpenClaw](https://docs.openclaw.ai/concepts/memory-builtin)
- [Документация QMD в OpenClaw](https://docs.openclaw.ai/concepts/memory-qmd)
- [Graphiti на GitHub](https://github.com/getzep/graphiti)
- [Драйвер Graphiti для FalkorDB](https://docs.openclaw.ai/api/drivers/falkordb)
- [Форк сообщества openclaw-graphiti-memory](https://github.com/clawdbrunner/openclaw-graphiti-memory)
- [OpenClaw memory masterclass (VelvetShark, 2026-03-05)](https://velvetshark.com/openclaw-memory-masterclass)
- [Advanced memory management in OpenClaw (LumaDock, 2026-02-23)](https://lumadock.com/tutorials/openclaw-advanced-memory-management)
