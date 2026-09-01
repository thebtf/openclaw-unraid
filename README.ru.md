# OpenClaw для Unraid

**Languages:** [English](./README.md) · [Русский](./README.ru.md) · [中文](./README.zh.md)

[![Unraid](https://img.shields.io/badge/Unraid-CA%20Template-orange)](https://unraid.net/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Шаблон Community Applications для [OpenClaw](https://github.com/openclaw/openclaw) — самостоятельно размещаемого шлюза AI-ассистента, работающего локально на вашем сервере Unraid.

![Дашборд OpenClaw](screenshot.png)

## Содержание

- [Что такое OpenClaw?](#что-такое-openclaw)
- [Требования](#требования)
- [Быстрый старт](#быстрый-старт)
- [Собственный LLM-роутер](#собственный-llm-роутер-litellm-vllm-ollama-и-др)
- [Конфигурация](#конфигурация)
- [Обновление](#обновление)
- [Устранение неполадок](#устранение-неполадок)
- [Установка до одобрения CA](#установка-до-одобрения-community-apps)
- [Ресурсы](#ресурсы)
- [Лицензия](#лицензия)
- [Благодарности](#благодарности)

---

## Что такое OpenClaw? <a id="что-такое-openclaw"></a>

OpenClaw — персональный AI-ассистент, работающий на вашем собственном сервере. Отвечает в мессенджерах, которыми вы уже пользуетесь, и хранит все данные на вашей машине.

### Поддержка каналов связи
- WhatsApp, Telegram, Discord, Slack, Google Chat, Signal, iMessage, Microsoft Teams, Matrix, Mattermost, BlueBubbles — и дополнительные через плагины.

### Возможности
- Мульти-агентная маршрутизация — изолируйте каналы и пользователей в отдельных рабочих пространствах
- Управление файлами — чтение, запись, организация файлов на сервере
- Выполнение команд оболочки — запуск скриптов, управление Docker, автоматизация чего угодно
- Управление браузером — исследование, получение данных, взаимодействие с веб-страницами
- Cron-задачи — расписание, напоминания, автоматизированные сценарии
- Система навыков — расширение возможностей встроенными или собственными скилами
- Голосовое управление и режим разговора — постоянно активная речь с TTS
- Live Canvas — визуальное рабочее пространство под управлением агента
- Мобильные клиенты — приложения-спутники для iOS и Android

### Ваши данные — ваш сервер
Рабочее пространство и конфигурация хранятся полностью на вашем сервере Unraid. Разговоры обрабатываются через API выбранного вами LLM-провайдера. Для полностью локальной работы укажите **Custom LLM Base URL**, направив его на [Ollama](https://ollama.ai), [LiteLLM](https://github.com/BerriAI/litellm) или любой OpenAI-совместимый роутер в вашей локальной сети.

## Требования <a id="требования"></a>

- Unraid 6.x или 7.x с включённым Docker
- Gateway Token (любая секретная строка — сгенерируйте через `openssl rand -hex 24`)
- URL разрешённых источников (например, `http://ВАШ-IP-UNRAID:18789`) — см. [почему это обязательно](#allowed-origins-required-since-openclaw-20262)
- Один источник LLM — на выбор:
  - API-ключ встроенного провайдера (Anthropic, OpenAI, OpenRouter, Gemini, Groq, xAI, Z.AI), **или**
  - URL собственного LLM-эндпоинта (LiteLLM, vLLM, Ollama, ваш роутер) — см. [Собственный LLM-роутер](#собственный-llm-роутер-litellm-vllm-ollama-и-др)

### Получение API-ключа Anthropic

1. Откройте [console.anthropic.com](https://console.anthropic.com)
2. Добавьте способ оплаты (Settings → Billing)
3. Перейдите в **API Keys** и создайте новый ключ (начинается с `sk-ant-`)

> **Важно:** доступ к API требует консольных кредитов — это отдельно от подписки Claude.ai Pro/Max. **Не используйте** `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` для работы с OpenClaw — Anthropic запрещает использование токенов подписки Claude Code в сторонних инструментах, и аккаунт может быть заблокирован.

### Использование сторонних провайдеров (OpenAI, Gemini, Groq, OpenRouter, xAI, Z.AI) <a id="использование-сторонних-провайдеров"></a>

OpenClaw по умолчанию использует Anthropic Claude. **Если вы используете другой провайдер, измените модель по умолчанию после установки:**

1. Установите OpenClaw с вашим API-ключом (например, `GEMINI_API_KEY`)
2. Откройте Control UI → вкладка **Config** → **Agents** → **Raw JSON**
3. Установите `agents.defaults.model.primary` в соответствии с вашим провайдером:

| Провайдер | Пример модели |
|-----------|---------------|
| Anthropic | `anthropic/claude-sonnet-4-5` (по умолчанию) |
| Google Gemini | `google/gemini-2.0-flash` |
| OpenAI | `openai/gpt-4o` |
| Groq | `groq/llama-3.1-70b-versatile` |
| OpenRouter | `openrouter/anthropic/claude-3-sonnet` |

4. Сохраните и перезапустите контейнер.

> **Почему это важно?** OpenClaw не определяет провайдера автоматически по API-ключу. Если задан ключ Gemini, а модель по умолчанию не изменена, вы получите ошибки `No API key found for provider "anthropic"`.

## Быстрый старт <a id="быстрый-старт"></a>

### Шаг 1: Установка из Community Apps

1. Найдите **OpenClaw** в Community Applications
2. Нажмите **Install**
3. Заполните **все обязательные поля**:
   - **Gateway Token** — `openssl rand -hex 24` или любое секретное значение
   - **Allowed Origins** — `http://ВАШ-IP-UNRAID:18789` (укажите IP вашего Unraid и порт Control UI). Несколько значений — через запятую без пробелов. **Обязательно — без этого шлюз не запустится.**
   - **LLM source** — одно из: API-ключ встроенного провайдера (Anthropic, OpenAI и др.) **или** собственный LLM-эндпоинт — см. [Собственный LLM-роутер](#собственный-llm-роутер-litellm-vllm-ollama-и-др) для описания всех полей
4. Нажмите **Apply**

### Шаг 2: Откройте Control UI

```
http://ВАШ-IP-UNRAID:18789/?token=ВАШ_GATEWAY_TOKEN
```

Параметр `?token=` обязателен. Пример: `http://192.168.1.41:18789/?token=mySecretToken123`
OpenClaw 2.0 привязывает браузер как подписанное устройство; один токен его не одобряет. Если запрос ожидает одобрения, следуйте разделу «Ожидается сопряжение браузерного устройства».

### Шаг 3: Выберите правильную модель (после установки)

Если вы использовали стороннего провайдера или собственный LLM-эндпоинт:

1. Control UI → вкладка **Config** → подвкладка **Agents** → **Raw JSON**
2. Для встроенного провайдера задайте `agents.defaults.model.primary` по таблице выше. Для собственного роутера задайте `agents.entries.main.model` равным `custom/<ваш-model-id>`.
3. **Сохраните** → перезапустите контейнер

### Шаг 4: (Опционально) Подключите канал мессенджера

Control UI → **Config** → **Channels** — заполните данные Telegram/Discord/Slack и др. Или задайте токены ботов в шаблоне (Discord, Telegram) и настройте привязку во вкладке **Agents** при первом сообщении.

## Собственный LLM-роутер (LiteLLM, vLLM, Ollama и др.) <a id="собственный-llm-роутер-litellm-vllm-ollama-и-др"></a>

Если вы используете собственный LLM-роутер или локальный сервер моделей, заполните четыре поля **Custom LLM** в шаблоне вместо (или вместе с) ключами встроенных провайдеров.

| Поле | Назначение | Пример |
|------|-----------|--------|
| `Custom LLM Base URL` | Корневой URL эндпоинта | `http://192.168.1.50:11434/v1` (Ollama), `http://litellm:4000/v1`, `https://my-router.example.com/v1` |
| `Custom LLM API Key` | Токен авторизации | `ollama` (для локального Ollama), токен вашего роутера в остальных случаях |
| `Custom LLM API Type` | Адаптер протокола (НЕ название модели) | Одно из: `openai-completions` (по умолчанию — LiteLLM/vLLM/Ollama/OpenRouter), `openai-responses`, `openai-codex-responses`, `anthropic-messages`, `google-generative-ai`, `github-copilot`, `bedrock-converse-stream`, `ollama`, `azure-openai-responses` |
| `Custom LLM Model ID` | ID модели(ей), предоставляемых эндпоинтом | `gpt-5.5`, `llama-3.1-70b` или несколько: `gpt-5.5,claude-3-opus` |

> **Распространённая ошибка:** `Custom LLM API Type` — это **адаптер протокола**, а не название модели. Если указать туда название модели, это не пройдёт валидацию схемы OpenClaw и шлюз откажется запускаться. Название модели — в поле `Custom LLM Model ID`.

Когда задан `Custom LLM Base URL`, бутстрап записывает блок `models.providers.custom` в `openclaw.json` через нативный CLI `openclaw config set`:

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "custom": {
        "baseUrl": "http://litellm:4000/v1",
        "apiKey": "${CUSTOM_LLM_API_KEY}",
        "api": "openai-completions",
        "models": [
          { "id": "gpt-5.5", "name": "gpt-5.5", "contextWindow": 128000, "maxTokens": 32000 }
        ]
      }
    }
  }
}
```

Ссылка `${CUSTOM_LLM_API_KEY}` разрешается при запуске шлюза, поэтому ключ никогда не записывается в конфиг в открытом виде.

> **Примечание:** значения `contextWindow` и `maxTokens` в сгенерированном конфиге берутся из полей шаблона **Custom LLM Context Window** и **Custom LLM Max Tokens** (по умолчанию: `128000` / `32000`). Подберите значения под вашу модель — например, `gpt-4o`: 128 000 / 16 384; `claude-3-opus`: 200 000 / 4 096; `gpt-5.5`: 1 050 000 / 128 000.

### Настройка агента на собственный провайдер

После установки укажите модель основного агента для использования собственного провайдера:

1. Control UI → **Config** → **Agents** → **Raw JSON**
2. Добавьте (или отредактируйте) блок agents:
   ```json
   {
     "agents": {
       "entries": {
         "main": {
           "model": "custom/llama-3.1-70b"
         }
       }
     }
   }
   ```
   Замените `llama-3.1-70b` на ID модели, которую предоставляет ваш роутер.
3. Сохраните → перезапустите контейнер

### Разрешённые источники (обязательно начиная с OpenClaw 2026.2) <a id="allowed-origins-required-since-openclaw-20262"></a>

Начиная с OpenClaw `2026.2.x` шлюз отказывается запускаться на не-loopback хостах, если `gateway.controlUi.allowedOrigins` явно не задан. Шаблон обеспечивает это через переменную `OPENCLAW_ALLOWED_ORIGINS`.

- **Одно значение:** `http://192.168.1.41:18789`
- **Несколько значений (через запятую):** `http://192.168.1.41:18789,http://openclaw.local:18789`
- **Пользователи обратного прокси:** добавьте также проксируемый источник — например, `http://192.168.1.41:18789,https://openclaw.example.com`

Список должен содержать **полные origins** (схема + хост + порт). Без подстановочных знаков, без завершающих слешей.

## Конфигурация <a id="конфигурация"></a>

### Справочник настроек шаблона

| Настройка | Тип | Обяз. | По умолчанию | Описание |
|-----------|-----|-------|--------------|----------|
| **Порты** |
| Control UI Port | Port | Да | `18789` | Порт веб-интерфейса и Gateway API |
| **Пути** |
| OpenClaw Data | Path | Да | `/mnt/user/appdata/openclaw/data` | Домашний каталог OpenClaw в `/home/node/.openclaw`: конфигурация, сессии, плагины, медиафайлы и учётные данные. |
| Workspace | Path | Да | `/mnt/user/appdata/openclaw/workspace` | Рабочее пространство агента в `/home/node/.openclaw/workspace`. Это подмонтирование каталога `workspace/` внутри OpenClaw Data. |
| Projects Path | Path | Нет | `/mnt/user/appdata/openclaw/projects` | Дополнительные проекты для разработки (продвинутый режим) |
| Homebrew Path | Path | Нет | `/mnt/user/appdata/openclaw/homebrew` | Постоянные пакеты Homebrew |
| Local Tools Path | Path | Нет | `/mnt/user/appdata/openclaw/local` | Постоянный `/home/node/.local` — установки pip `--user`, вручную собранные CLI в `bin/`, библиотеки в `lib/`. Сохраняется при перезапусках. |
| Logs Path | Path | Нет | `/mnt/user/appdata/openclaw/logs` | Лог-файлы шлюза. Образ закрепляет `logging.file=/tmp/openclaw/openclaw.log`; по умолчанию ротация выполняется при 100 МБ и хранит пять архивов. |
| **Обязательные** |
| PUID | Variable | Да | `99` | UID хоста, от которого работает шлюз. `99` = `nobody` в Unraid. Узнайте свой: `id $USER` в консоли Unraid. |
| PGID | Variable | Да | `100` | GID хоста. `100` = `users` в Unraid. |
| Gateway Token | Variable | Да | — | Секрет для доступа к API/UI |
| Allowed Origins | Variable | Да | — | Разрешённые browser-источники через запятую. См. [раздел выше](#allowed-origins-required-since-openclaw-20262) |
| **Custom LLM (опциональная альтернатива встроенным ключам)** |
| Custom LLM Base URL | Variable | Нет | — | Корневой URL эндпоинта |
| Custom LLM API Key | Variable | Нет | — | Токен для собственного эндпоинта |
| Custom LLM API Type | Variable | Нет | `openai-completions` | Адаптер протокола — см. [список выше](#собственный-llm-роутер-litellm-vllm-ollama-и-др) |
| Custom LLM Model ID | Variable | Нет | — | ID модели(ей) эндпоинта. Обязательно, если задан Custom LLM Base URL. Несколько — через запятую. |
| Custom LLM Context Window | Variable | Нет | `128000` | Общий контекстный буфер в токенах. Укажите реальное значение для вашей модели (gpt-4o=128k, claude-3-opus=200k, gpt-5=400k). |
| Custom LLM Max Tokens | Variable | Нет | `32000` | Максимум токенов в одном ответе. Подберите под модель (gpt-4o=16384, claude-3-opus=4096, gpt-5=32000). |
| **Встроенные LLM-провайдеры** |
| Anthropic API Key | Variable | Нет | — | Модели Claude |
| OpenAI API Key | Variable | Нет | — | Модели GPT |
| OpenRouter API Key | Variable | Нет | — | 100+ моделей через единый API |
| Gemini API Key | Variable | Нет | — | Google Gemini |
| Groq API Key | Variable | Нет | — | Быстрые модели Llama/Mixtral |
| xAI API Key | Variable | Нет | — | Grok |
| Z.AI API Key | Variable | Нет | — | Zhipu GLM |
| **Авторизация по подписке** |
| GitHub Copilot Token | Variable | Нет | — | Продвинутый режим — см. документацию OpenClaw |
| **Каналы (настраиваются после установки)** |
| Discord Bot Token | Variable | Нет | — | Интеграция с Discord |
| Telegram Bot Token | Variable | Нет | — | Telegram-бот от [@BotFather](https://t.me/BotFather) |
| **Продвинутые** |
| Gateway Port | Variable | Нет | `18789` | Переопределите, если порт 18789 занят |
| Log Max File Bytes | Variable | Нет | `104857600` | 100 МБ на лог-файл до ротации. Количество архивов, равное 5, жёстко задано в OpenClaw. |
| Skip Ownership Init | Variable | Нет | `0` | Установите `1`, чтобы пропустить однократное выравнивание владельцев точек монтирования при запуске. Используйте только при внешнем управлении владельцами. |
| Custom LLM Reasoning | Variable | Нет | `1` | Указывает, поддерживает ли модель собственного LLM блоки reasoning/thinking. По умолчанию `1` для современных reasoning-моделей. Установите `0` для моделей без reasoning. |
| Skip System Path Remap | Variable | Нет | `0` | Установите `1`, чтобы пропустить рекурсивный `chown` в `/home/node` и `/app` при запуске. Используйте только если файловая система уже выровнена и контейнер не будет пересоздан. |
| PATH | Variable | Нет | (авто) | Системный PATH — включает `/home/node/.local/bin`, `/home/node/.cargo/bin`, Homebrew и Bun. Полное значение — в `<Default>` файла `openclaw.xml`. |
| Web Search API Key | Variable | Нет | — | Brave Search API |

### Монтирование томов

| Путь в контейнере | Путь на хосте | Описание |
|-------------------|---------------|----------|
| `/home/node/.openclaw` | `/mnt/user/appdata/openclaw/data` | Домашний каталог OpenClaw: конфиг, сессии, плагины, медиафайлы и учётные данные |
| `/home/node/.openclaw/workspace` | `/mnt/user/appdata/openclaw/workspace` | Рабочее пространство агента — подмонтирование внутри OpenClaw Data |
| `/projects` | `/mnt/user/appdata/openclaw/projects` | Опциональные проекты для разработки |
| `/home/linuxbrew/.linuxbrew` | `/mnt/user/appdata/openclaw/homebrew` | Пакеты Homebrew |
| `/home/node/.local` | `/mnt/user/appdata/openclaw/local` | Установки pip `--user`, вручную собранные CLI и библиотеки |
| `/tmp/openclaw` | `/mnt/user/appdata/openclaw/logs` | Лог-файлы шлюза: 100 МБ на файл и пять архивов по умолчанию, всего около 600 МБ |

### Логи

Бутстрап закрепляет `logging.file=/tmp/openclaw/openclaw.log`, поэтому логи надёжно сохраняются на хостовом томе. OpenClaw 2026.4 разделяет стандартные пути по экземплярам (`/tmp/openclaw-0/`), а закреплённый путь использует монтирование `/tmp/openclaw`.

Встроенная ротация: когда активный лог достигает `Log Max File Bytes` (по умолчанию 100 МБ), OpenClaw переименовывает его в `openclaw.1.log` и создаёт новый. Хранятся 5 пронумерованных архивов. Общий объём на диске ≈ `6 × Log Max File Bytes` = ~600 МБ при настройках по умолчанию.

Следить за логами в реальном времени:
```bash
tail -f /mnt/user/appdata/openclaw/logs/openclaw-*.log
```

Очистить логи:
```bash
rm /mnt/user/appdata/openclaw/logs/openclaw*.log
docker restart OpenClaw
```

### Поддержка Homebrew и навыков

Некоторые навыки требуют `go`, `npm` или других инструментов, устанавливаемых через Homebrew. Homebrew **не обязателен**.

Для установки откройте консоль контейнера и выполните:
```bash
NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Вывод «Next steps» можно проигнорировать — `PATH` уже настроен шаблоном. Homebrew и пакеты сохраняются в томе Homebrew Path.

**Известное ограничение:** навыки, требующие Go (`blogwatcher`, `blucli`), могут завершиться по тайм-ауту при первой установке, пока Go скачивается. Нажмите **Install** повторно — со второй попытки установка пройдёт успешно.

### Справочник по конфигурационному файлу

Основной конфиг: `/mnt/user/appdata/openclaw/data/openclaw.json`

При первом запуске бутстрап создаёт минимальный конфиг:
```json
{
  "gateway": {
    "mode": "local",
    "bind": "lan",
    "controlUi": {
      "allowedOrigins": ["http://ВАШ-IP-UNRAID:18789"]
    },
    "auth": { "mode": "token" }
  }
}
```
Авторизация по токену остаётся обязательной. OpenClaw также требует подписанную привязку браузерного устройства: токен не одобряет браузер.

Если задан `Custom LLM Base URL`, при первом запуске также создаётся блок `models.providers.custom`.

После первого запуска этот файл принадлежит OpenClaw — редактируйте через Control UI **Config** → **Raw JSON**, чтобы изменения сохранялись корректно.

> **Важно:** OpenClaw перезаписывает конфиг при сохранении через Control UI и сериализует ссылки `${VAR}` как обычный текст. Если вы редактировали файл вручную и использовали подстановку переменных окружения, следующее сохранение через UI может встроить уже разрешённые значения.

Полная схема: [docs.openclaw.ai/gateway/configuration-reference](https://docs.openclaw.ai/gateway/configuration-reference)

### Подключение каналов мессенджеров

После установки настройте каналы через страницу **Config** в Control UI или отредактируйте `openclaw.json` напрямую:

```json
{
  "channels": {
    "discord": { "enabled": true, "token": "${DISCORD_BOT_TOKEN}" },
    "telegram": { "enabled": true, "botToken": "${TELEGRAM_BOT_TOKEN}" }
  }
}
```

Полные руководства по каналам: [OpenClaw Docs — Channels](https://docs.openclaw.ai/channels)

## Обновление <a id="обновление"></a>

**Через Docker UI Unraid:**
1. Вкладка Docker → нажмите на иконку OpenClaw → Check for Updates → Apply

**Через командную строку:**
```bash
docker pull ghcr.io/thebtf/openclaw-unraid:latest
docker restart OpenClaw
```
> **Важно для OpenClaw 2.0:** сессии и транскрипты перенесены в SQLite. Перед обновлением сделайте и проверьте резервную копию OpenClaw Data. Перед откатом используйте актуальный CLI OpenClaw, чтобы восстановить архивные артефакты прежних транскриптов. См. [руководство OpenClaw по обновлению и откату](https://docs.openclaw.ai/install/updating).

### Существующая сохранённая конфигурация

Перед обновлением сделайте и проверьте резервную копию OpenClaw Data. При первом запуске после обновления, если существующая конфигурация не проходит проверку, образ выполняет узкую миграцию с резервным копированием до управляемых шаблоном записей и первоначального заполнения. Он создаёт резервную копию с меткой времени `openclaw.json.v2026.8.1-backup-*`, проверяет перенесённую конфигурацию, затем продолжает управляемые записи и заполнение в том же запуске. Если миграция или проверка завершается ошибкой, entrypoint безопасно отказывает.

Подписанное сопряжение браузерного устройства остаётся ожидаемым в OpenClaw 2.0. Одобрите ожидающий запрос браузера, как описано в разделе [Ожидается сопряжение браузерного устройства](#ожидается-сопряжение-браузерного-устройства).

Для целевой диагностики проверьте логи контейнера на строку `[bootstrap] existing config needs OpenClaw migration; applying narrow backup-first migration`. Не используйте полный `openclaw doctor --fix` как штатное восстановление после обновления. Это инструмент ручной диагностики после сохранения резервной копии; entrypoint никогда не запускает его автоматически.

Если контейнер остановлен и не может запустить мигратор образа, используйте ручной вариант из этого репозитория. Найдите путь хоста **OpenClaw Data** в шаблоне Unraid. Не вставляйте значения конфигурации в команду. Сначала выполните `python3 scripts/migrate-openclaw-2-config.py <путь-хоста-OpenClaw-Data>/openclaw.json`; по умолчанию это пробный запуск. После проверки вывода добавьте `--apply`, чтобы выполнить миграцию. Скрипт создаёт рядом резервную копию с меткой времени, побайтно идентичную исходному файлу, и выводит только затронутые пути.
При обновлении сохраняются заполненные значения и пользовательские переменные окружения, но явно выведенные из эксплуатации переменные шаблона отбрасываются. `OPENCLAW_DISABLE_DEVICE_AUTH` больше не применяется.


**Если изменился сам шаблон** (новые настройки, поведение образа или схема монтирования), выполните в консоли Unraid:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/thebtf/openclaw-unraid/master/scripts/update-on-unraid.sh)"
```

Обёртка автоматически находит установленный контейнер по уникальным признакам шаблона, обновляет upstream `openclaw.xml` и объединяет его с сохранённым `my-<Name>.xml`. Она сохраняет заполненные вами значения, создаёт `.bak` и выводит список новых полей.

После завершения откройте Unraid Web UI → Docker → ваш контейнер → **Edit Container**, задайте показанные новые поля и нажмите **Apply**.

## Устранение неполадок <a id="устранение-неполадок"></a>

### `origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)`

Origin вашего браузера отсутствует в списке `allowedOrigins`.

1. Убедитесь, что поле **Allowed Origins** в шаблоне **точно совпадает** с URL, который вы открываете — одинаковая схема (`http`/`https`), хост (IP или имя) и порт. `http://192.168.1.41:18789` ≠ `http://homelab:18789`.
2. Если вы заходите с нескольких хостов (LAN IP + mDNS + обратный прокси), добавьте **все** через запятую:
   ```
   http://192.168.1.41:18789,http://openclaw.local:18789,https://openclaw.example.com
   ```
3. Отредактируйте поле шаблона, нажмите **Apply**, затем **перезапустите** контейнер. Бутстрап идемпотентен и добавит новые origins при следующем запуске, не затрагивая остальные настройки.

### `non-loopback Control UI requires gateway.controlUi.allowedOrigins`

Шлюз отказывается запускаться, так как не заданы разрешённые источники. Заполните поле **Allowed Origins** в шаблоне, как описано выше, и перезапустите контейнер.

### Ожидается сопряжение браузерного устройства

OpenClaw 2.0 требует подписанное сопряжение браузерного устройства наряду с авторизацией по токену. Токен в ссылке Dashboard не одобряет браузер.

1. Получите свежую ссылку Dashboard и откройте её в браузере, который хотите использовать.
2. В консоли контейнера выполните `openclaw devices list`, чтобы найти ожидающий запрос сопряжения.
3. Если требуется одобрение, выполните `openclaw devices approve <requestId>` для этого запроса.

### `No API key found for provider "anthropic"`

Вы указали ключ стороннего провайдера, но модель по умолчанию осталась `anthropic/claude-sonnet-4-5`. Измените `agents.defaults.model.primary` на нужного провайдера — см. [Использование сторонних провайдеров](#использование-сторонних-провайдеров).

### `Config invalid` / `models.providers.custom.api: Invalid option`

В поле **Custom LLM API Type** указано название модели (например `gpt-5.5`). Это поле — **адаптер протокола** — см. раздел [Собственный LLM-роутер](#собственный-llm-роутер-litellm-vllm-ollama-и-др) с допустимыми значениями. Название модели — в поле **Custom LLM Model ID**.

Исправьте поля шаблона, нажмите **Apply**, перезапустите контейнер.

### `models.providers.custom.models: Invalid input: expected array`

Задан Custom LLM-эндпоинт, но поле **Custom LLM Model ID** пустое. Укажите хотя бы один ID модели (например `gpt-5.5`).

### Файлы в папке appdata не видны по SMB / NFS

Шлюз запускается с `PUID:PGID`; по умолчанию это `99:100` (`nobody:users`). При старте образ один раз выравнивает владельцев точек монтирования с этими идентификаторами, затем запускает шлюз с ними. Фонового цикла смены владельцев нет.

1. Узнайте UID и GID пользователя Unraid: `id $USER`.
2. Укажите эти значения в полях шаблона **PUID** и **PGID**, затем нажмите **Apply** и перезапустите контейнер.
3. Если владельцами управляет внешний инструмент, установите `OPENCLAW_SKIP_OWNERSHIP_INIT=1`, чтобы пропустить только однократное выравнивание при запуске.

### Контейнер переходит в STOP после перезапуска шлюза

OpenClaw завершает процесс шлюза при сохранении некоторых настроек через Control UI (например, при смене модели по умолчанию). Без явной политики перезапуска Docker контейнер так и останется остановленным.

В шаблоне задан флаг `--restart=unless-stopped` в `ExtraParams`, поэтому Docker автоматически перезапускает контейнер после любого нештатного завершения. Если вы удалили этот флаг или ваш контейнер был создан до его добавления:

```bash
docker update --restart=unless-stopped OpenClaw
```

Или через веб-интерфейс Unraid: **Edit Container** → задайте **Restart Policy** значение `Unless Stopped` → Apply.

Если контейнер по-прежнему уходит в STOP после сохранения, проверьте сообщение о выходе бутстрапа:

```bash
docker logs OpenClaw 2>&1 | grep "gateway exited"
```

`rc=0` означает штатный выход (перезагрузка конфига) — политика перезапуска должна сработать. `rc=1` или выше означает реальный сбой; поделитесь окружающими строками лога.

### Контейнер не запускается / ошибка «Missing config»

Сначала проверьте логи:
```bash
docker logs OpenClaw 2>&1 | tail -50
```

Бутстрап выводит строки `[bootstrap]` для каждого действия. Типичные критические ошибки:
- `FATAL: OPENCLAW_ALLOWED_ORIGINS is required` — заполните поле **Allowed Origins** в шаблоне.
- `FATAL: CUSTOM_LLM_API_TYPE='...' is invalid` — см. допустимые значения адаптера выше.
- `FATAL: CUSTOM_LLM_MODEL_ID is required` — задайте хотя бы один ID модели.
- `FATAL: openclaw rejected the config update` — ошибка валидации схемы; проблемный JSON выводится ниже сообщения об ошибке.

Для принудительного сброса конфига (теряются все правки через UI):
```bash
rm /mnt/user/appdata/openclaw/data/openclaw.json
docker restart OpenClaw
```

### Перезапуск шлюза внутри контейнера

Команда `openclaw gateway restart` (upstream CLI) **не работает** внутри этого образа. Она рассчитана на хостовую установку с юнитом systemd-user (`systemctl --user`); внутри контейнера systemd нет, поэтому CLI завершается с ошибкой:

```
systemctl not available; systemd user services are required on Linux.
```

Это ограничение upstream, отслеживаемое в [openclaw/openclaw#72224](https://github.com/openclaw/openclaw/issues/72224) («fix gateway restart outside systemd»). До выхода исправления в релизе используйте один из вариантов ниже.

#### Три способа перезапуска — от наименее к наиболее деструктивному

**1. Горячий in-process перезапуск через SIGUSR1** (самый быстрый, без простоя контейнера, применяет изменения из `openclaw.json`):

```bash
docker exec OpenClaw sh -c 'kill -USR1 $(pidof openclaw-gateway)'
```

Это тот же путь, который шлюз использует внутри для горячей перезагрузки после сохранения конфига. Каналы, плагины и навыки переинициализируются; запросы в процессе выполнения могут быть прерваны. Задокументирован как полноценный триггер перезапуска в [`docs/cli/gateway.md`](https://github.com/openclaw/openclaw/blob/main/docs/cli/gateway.md) (по умолчанию `commands.restart: true`, авторизация включена).

**2. Перезапуск контейнера** (гарантированно чистое состояние, ~10–15 с простоя):

- Через веб-интерфейс Unraid: **Docker** → нажмите на иконку OpenClaw → **Restart**, или
- ```bash
  docker restart OpenClaw
  ```

Используйте, если шлюз завис, после обновления образа или если SIGUSR1 не применил изменения.

**3. Полный перезапуск бутстрапа** (только если сам конфигурационный файл сломан):

```bash
rm /mnt/user/appdata/openclaw/data/openclaw.json
docker restart OpenClaw
```

При этом вы потеряете правки, сделанные через UI, — бутстрап пересоздаст всё из переменных окружения шаблона при следующем запуске. Используйте как крайнюю меру.

## Установка до одобрения Community Apps <a id="установка-до-одобрения-community-apps"></a>

Ещё не появилось в CA? Установите через терминал:

**Шаг 1:** Подключитесь к серверу Unraid по SSH и выполните:
```bash
curl -o /boot/config/plugins/dockerMan/templates-user/openclaw.xml \
  https://raw.githubusercontent.com/thebtf/openclaw-unraid/master/openclaw.xml
```

**Шаг 2:** Обновите страницу Docker в Unraid

**Шаг 3:** **Docker** → **Add Container** → выберите **OpenClaw** в выпадающем списке Template

**Шаг 4:** Заполните обязательные поля (Gateway Token, Allowed Origins, один источник LLM) и нажмите **Apply**.

<details>
<summary><strong>Продвинутый режим: ручной запуск Docker</strong></summary>

```bash
mkdir -p /mnt/user/appdata/openclaw/{data,workspace,homebrew,local,logs}

docker run -d \
  --name OpenClaw \
  --network bridge \
  --hostname OpenClaw \
  --restart unless-stopped \
  -p 18789:18789 \
  -v /mnt/user/appdata/openclaw/data:/home/node/.openclaw:rw \
  -v /mnt/user/appdata/openclaw/workspace:/home/node/.openclaw/workspace:rw \
  -v /mnt/user/appdata/openclaw/homebrew:/home/linuxbrew/.linuxbrew:rw \
  -v /mnt/user/appdata/openclaw/local:/home/node/.local:rw \
  -v /mnt/user/appdata/openclaw/logs:/tmp/openclaw:rw \
  -e PUID=99 \
  -e PGID=100 \
  -e OPENCLAW_GATEWAY_PORT=18789 \
  -e OPENCLAW_LOG_MAX_FILE_BYTES=104857600 \
  -e OPENCLAW_GATEWAY_TOKEN=YOUR_TOKEN \
  -e OPENCLAW_ALLOWED_ORIGINS=http://YOUR-UNRAID-IP:18789 \
  -e ANTHROPIC_API_KEY=sk-ant-YOUR_KEY \
  -e PATH=/home/node/.local/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/home/node/.bun/bin:/home/node/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  ghcr.io/thebtf/openclaw-unraid:latest

</details>

## Бэкенды памяти (QMD, Graphiti, FalkorDB и др.)

Встроенная память хорошо подходит для повседневного использования. Для улучшенного поиска, графов знаний или общих фактов между несколькими агентами — см. [`docs/MEMORY-SETUP.ru.md`](docs/MEMORY-SETUP.ru.md): полное руководство по настройке QMD (обновление в одну строку), Graphiti + FalkorDB (граф памяти), Cognee и Mem0.

## Ресурсы <a id="ресурсы"></a>

- **Тема поддержки на Unraid:** https://forums.unraid.net/topic/196865-support-openclaw-ai-personal-assistant/
- **Документация OpenClaw:** https://docs.openclaw.ai
- **GitHub OpenClaw:** https://github.com/openclaw/openclaw
- **Discord OpenClaw:** https://discord.gg/clawd
- **Репозиторий шаблона:** https://github.com/thebtf/openclaw-unraid
- **Руководство по памяти:** [`docs/MEMORY-SETUP.ru.md`](docs/MEMORY-SETUP.ru.md)

## Лицензия <a id="лицензия"></a>

[MIT](LICENSE). OpenClaw распространяется под лицензией MIT — см. [репозиторий OpenClaw](https://github.com/openclaw/openclaw).

## Как запускается образ

Производный образ содержит версионируемую точку входа, которая запускается при каждом запуске контейнера. Она выравнивает постоянные точки монтирования с `PUID:PGID`, применяет поддерживаемые настройки шлюза и логирования и запускает OpenClaw от имени этого пользователя.

При первом запуске точка входа создаёт провайдера Custom LLM и основного агента, если заполнены поля Custom LLM. Позднее запуски сохраняют конфигурацию OpenClaw, изменённую через Control UI.

Точка входа использует нативный CLI конфигурации OpenClaw, поэтому значения проверяет OpenClaw до запуска шлюза. Ручная Docker-команда использует встроенное поведение образа для пользователя и точки входа. Не добавляйте команду бутстрапа.

## Благодарности <a id="благодарности"></a>

- **Команда OpenClaw** — Peter Steinberger ([@steipete](https://twitter.com/steipete)) и контрибьюторы
- **Оригинальный шаблон CA** — [@jdhill777](https://github.com/jdhill777)
- **Этот форк** — [@thebtf](https://github.com/thebtf)
- **Протестировано на** — Unraid 7.x

---

**Вопросы?** Откройте issue или присоединяйтесь к [Discord OpenClaw](https://discord.gg/clawd).
