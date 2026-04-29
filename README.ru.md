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

### Шаг 3: Выберите правильную модель (после установки)

Если вы использовали стороннего провайдера или собственный LLM-эндпоинт:

1. Control UI → вкладка **Config** → подвкладка **Agents** → **Raw JSON**
2. Задайте `agents.defaults.model.primary` (см. таблицу выше для встроенных провайдеров; для собственного роутера используйте `custom/<ваш-model-id>`)
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

После установки задайте модель по умолчанию для использования собственного провайдера:

1. Control UI → **Config** → **Agents** → **Raw JSON**
2. Добавьте (или отредактируйте) блок agents:
   ```json
   {
     "agents": {
       "defaults": {
         "model": { "primary": "custom/llama-3.1-70b" }
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
| Config Path | Path | Да | `/mnt/user/appdata/openclaw/config` | Конфигурация, сессии, учётные данные |
| Workspace Path | Path | Да | `/mnt/user/appdata/openclaw/workspace` | Файлы агента, память, проекты |
| Projects Path | Path | Нет | `/mnt/user/appdata/openclaw/projects` | Дополнительные проекты для разработки (продвинутый режим) |
| Homebrew Path | Path | Нет | `/mnt/user/appdata/openclaw/homebrew` | Постоянные пакеты Homebrew |
| Local Tools Path | Path | Нет | `/mnt/user/appdata/openclaw/local` | Постоянный `~/.local` — установки pip `--user`, вручную собранные CLI в `bin/`, библиотеки в `lib/`. Сохраняется при перезапусках. |
| Logs Path | Path | Нет | `/mnt/user/appdata/openclaw/logs` | Лог-файлы шлюза (монтируется в `/tmp/openclaw` — runtime OpenClaw всегда пишет туда, см. [issue #61295](https://github.com/openclaw/openclaw/issues/61295)) |
| **Обязательные** |
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
| Disable Device Auth | Variable | Нет | `true` | Удобный режим для локальной сети; укажите `false`, если Control UI доступен по HTTPS |
| Log Max File Bytes | Variable | Нет | `26214400` | 25 МБ на лог-файл до ротации. Количество архивов жёстко задано равным 5 в OpenClaw. |
| Skip Permission Fix | Variable | Нет | `0` | Установите `1`, чтобы отключить универсальный фикс прав (umask 0002 + setgid для директорий). Отключайте только при внешнем управлении правами. |
| Perm Fix Interval | Variable | Нет | `5` | Интервал (в секундах) между проходами runtime-синхронизации владельца (цикл `chown --reference`). Увеличьте до 30+ на медленных дисках; 0 — однократный запуск при старте. |
| PATH | Variable | Нет | (авто) | Системный PATH — включает `~/.local/bin`, `~/.cargo/bin`, Homebrew, Bun. Полное значение — в `<Default>` файла `openclaw.xml`. |
| Web Search API Key | Variable | Нет | — | Brave Search API |

### Монтирование томов

| Путь в контейнере | Путь на хосте | Описание |
|-------------------|---------------|----------|
| `/root/.openclaw` | `/mnt/user/appdata/openclaw/config` | Конфиг, сессии, учётные данные |
| `/home/node/clawd` | `/mnt/user/appdata/openclaw/workspace` | Рабочее пространство агента |
| `/projects` | `/mnt/user/appdata/openclaw/projects` | Опциональные проекты для разработки |
| `/home/linuxbrew/.linuxbrew` | `/mnt/user/appdata/openclaw/homebrew` | Пакеты Homebrew |
| `/root/.local` | `/mnt/user/appdata/openclaw/local` | `~/.local` — pip `--user`, вручную собранные CLI (например `~/.local/bin/obscura`), библиотеки |
| `/tmp/openclaw` | `/mnt/user/appdata/openclaw/logs` | Лог-файлы шлюза (ротация средствами OpenClaw, ограничение по умолчанию ~150 МБ) |

### Логи

Runtime OpenClaw всегда пишет логи в `/tmp/openclaw/openclaw-YYYY-MM-DD.log` (параметр конфига `logging.file` сейчас игнорируется — см. [openclaw issue #61295](https://github.com/openclaw/openclaw/issues/61295)). Шаблон монтирует `/tmp/openclaw` в `/mnt/user/appdata/openclaw/logs` на хосте, чтобы логи не накапливались на overlay-файловой системе контейнера.

Встроенная ротация: когда активный лог достигает **Log Max File Bytes** (по умолчанию 25 МБ), OpenClaw переименовывает его в `openclaw-YYYY-MM-DD.1.log` и начинает новый. Хранятся 5 пронумерованных архивов (количество жёстко задано в OpenClaw). Общий объём на диске ≈ `6 × Log Max File Bytes` = ~150 МБ при настройках по умолчанию.

Следить за логами в реальном времени:
```bash
tail -f /mnt/user/appdata/openclaw/logs/openclaw-*.log
```

Очистить логи:
```bash
rm /mnt/user/appdata/openclaw/logs/openclaw-*.log
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

Основной конфиг: `/mnt/user/appdata/openclaw/config/openclaw.json`

При первом запуске бутстрап создаёт минимальный конфиг:
```json
{
  "gateway": {
    "mode": "local",
    "bind": "lan",
    "controlUi": {
      "allowInsecureAuth": true,
      "allowedOrigins": ["http://ВАШ-IP-UNRAID:18789"]
    },
    "auth": { "mode": "token" }
  }
}
```

Если задан `Custom LLM Base URL`, к нему добавляется блок `models.providers.custom`.

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
docker pull ghcr.io/openclaw/openclaw:latest
docker restart OpenClaw
```

**Если изменился сам шаблон** (новые переменные окружения, обновлённые PostArgs, реструктурированные ExtraParams):

```bash
python3 scripts/merge-template.py \
    --stored /boot/config/plugins/dockerMan/templates-user/my-OpenClaw.xml \
    --upstream /boot/config/plugins/dockerMan/templates-user/openclaw.xml \
    --output /boot/config/plugins/dockerMan/templates-user/my-OpenClaw.xml
```

Скрипт накладывает значения, заполненные пользователем в сохранённом шаблоне, на upstream-xml, сохраняет `.bak` исходника и выводит новые поля, которые стоит проверить в UI «Edit Container». Запустите скрипт **до** нажатия «Edit Container», чтобы токены, API-ключи и пути сохранились при обновлении, а новые поля уровня шаблона подтянулись автоматически.

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

### `control ui requires device identity (use HTTPS or localhost secure context)`

Браузеры требуют безопасного контекста (HTTPS или `http://localhost`) для использования Web Crypto API, который OpenClaw применяет для подписи device-identity. Обычный HTTP на LAN IP или hostname под это требование не подпадает.

Два варианта решения:
- **Использовать HTTPS** — поставьте перед контейнером обратный прокси (Traefik, Caddy, NPM) и открывайте `https://ваш-домен/?token=...`. Затем установите `OPENCLAW_DISABLE_DEVICE_AUTH=false` в шаблоне для полной защиты device-identity.
- **Отключить device auth (вариант по умолчанию в этом шаблоне)** — `OPENCLAW_DISABLE_DEVICE_AUTH=true` (по умолчанию). Авторизация по токену по-прежнему обязательна. Приемлемо для домашнего использования в локальной сети; не рекомендуется при открытом доступе из интернета.

Шаблон по умолчанию использует `true`, так как большинство пользователей Unraid открывают Control UI через обычный HTTP в локальной сети. Если у вас уже настроен HTTPS — переключите на `false`.

### `disconnected (1008): control ui requires HTTPS or localhost`

Убедитесь, что к URL добавлен токен:
```
http://ВАШ-IP:18789/?token=ВАШ_ТОКЕН
```

Если ошибка сохраняется, проверьте конфигурационный файл:
```bash
cat /mnt/user/appdata/openclaw/config/openclaw.json
```

### `No API key found for provider "anthropic"`

Вы указали ключ стороннего провайдера, но модель по умолчанию осталась `anthropic/claude-sonnet-4-5`. Измените `agents.defaults.model.primary` на нужного провайдера — см. [Использование сторонних провайдеров](#использование-сторонних-провайдеров).

### `Config invalid` / `models.providers.custom.api: Invalid option`

В поле **Custom LLM API Type** указано название модели (например `gpt-5.5`). Это поле — **адаптер протокола** — см. раздел [Собственный LLM-роутер](#собственный-llm-роутер-litellm-vllm-ollama-и-др) с допустимыми значениями. Название модели — в поле **Custom LLM Model ID**.

Исправьте поля шаблона, нажмите **Apply**, перезапустите контейнер.

### `models.providers.custom.models: Invalid input: expected array`

Задан Custom LLM-эндпоинт, но поле **Custom LLM Model ID** пустое. Укажите хотя бы один ID модели (например `gpt-5.5`).

### Файлы в папке appdata не видны по SMB / NFS

Контейнер работает от root. Без дополнительных мер каждый новый файл создавался бы с правами `root:root 0600`, и пользователь SMB-шары не смог бы его увидеть.

Бутстрап решает это в два этапа при каждом запуске контейнера:

1. **Однократный фикс** — выравнивает владельца по корневой точке монтирования и устанавливает `umask 0002` + `chmod g+s` на директории, чтобы новые файлы наследовали группу.
2. **Фоновый цикл синхронизации владельца** — каждые `OPENCLAW_PERM_FIX_INTERVAL` секунд (по умолчанию 5) повторно запускает `chown --reference` для корневых точек монтирования. Это необходимо для файлов, которые OpenClaw ротирует или создаёт в runtime (например, `openclaw.json.bak` после каждого сохранения через UI).

#### Однократная настройка на стороне хоста

Бутстрап берёт UID/GID из самой точки монтирования, поэтому **один раз** задайте владельца на хосте — такого, какого ожидает ваш SMB/NFS-пользователь. Узнайте UID/GID командой `id $USER`, затем:

```bash
# Замените YOUR_UID:YOUR_GID на ваши значения (например 99:100 = nobody:users)
chown -R YOUR_UID:YOUR_GID /mnt/user/appdata/openclaw
chmod -R g+rwX,o+rX /mnt/user/appdata/openclaw
find /mnt/user/appdata/openclaw -type d -exec chmod g+s {} +
```

Это то же самое, что делает бутстрап при старте. Ручной запуск сразу исправляет существующие файлы без ожидания перезапуска. После этого перезапустите контейнер (или подождите `OPENCLAW_PERM_FIX_INTERVAL` секунд), чтобы runtime-цикл подхватил новые данные о владельце.

#### Проверка

```bash
ls -la /mnt/user/appdata/openclaw/config/
```

Директории должны иметь вид `drwxrwsr-x` с вашим UID/GID (символ `s` в правах группы — это бит setgid). Большинство файлов — `-rw-rw-r--`. Обратите внимание: **`openclaw.json` остаётся `-rw-------`** — OpenClaw намеренно создаёт его с режимом 0600, так как файл содержит gateway-токен и ключи провайдеров. Владелец читает нормально через SMB; остальные пользователи намеренно лишены доступа.

#### Тонкая настройка

- `OPENCLAW_PERM_FIX_INTERVAL` — интервал (в секундах) для цикла синхронизации владельца. По умолчанию 5. Увеличьте до 30+ на медленных дисках.
- `OPENCLAW_SKIP_PERM_FIX=1` — полностью отключает как однократный фикс, так и фоновый цикл. Используйте только при внешнем управлении правами.

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
rm /mnt/user/appdata/openclaw/config/openclaw.json
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
rm /mnt/user/appdata/openclaw/config/openclaw.json
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
mkdir -p /mnt/user/appdata/openclaw/{config,workspace,homebrew}

docker run -d \
  --name OpenClaw \
  --network bridge \
  --user root \
  --hostname OpenClaw \
  --restart unless-stopped \
  -p 18789:18789 \
  -v /mnt/user/appdata/openclaw/config:/root/.openclaw:rw \
  -v /mnt/user/appdata/openclaw/workspace:/home/node/clawd:rw \
  -v /mnt/user/appdata/openclaw/homebrew:/home/linuxbrew/.linuxbrew:rw \
  -e OPENCLAW_GATEWAY_TOKEN=YOUR_TOKEN \
  -e OPENCLAW_ALLOWED_ORIGINS=http://YOUR-UNRAID-IP:18789 \
  -e ANTHROPIC_API_KEY=sk-ant-YOUR_KEY \
  -e PATH=/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  ghcr.io/openclaw/openclaw:latest \
  sh -c '...bootstrap from openclaw.xml PostArgs...'
```

(Скопируйте полное значение `PostArgs` из `openclaw.xml` в качестве последнего аргумента.)

</details>

## Бэкенды памяти (QMD, Graphiti, FalkorDB и др.)

Встроенная память хорошо подходит для повседневного использования. Для улучшенного поиска, графов знаний или общих фактов между несколькими агентами — см. [`docs/MEMORY-SETUP.md`](docs/MEMORY-SETUP.ru.md): полное руководство по настройке QMD (обновление в одну строку), Graphiti + FalkorDB (граф памяти), Cognee и Mem0.

## Ресурсы <a id="ресурсы"></a>

- **Тема поддержки на Unraid:** https://forums.unraid.net/topic/196865-support-openclaw-ai-personal-assistant/
- **Документация OpenClaw:** https://docs.openclaw.ai
- **GitHub OpenClaw:** https://github.com/openclaw/openclaw
- **Discord OpenClaw:** https://discord.gg/clawd
- **Репозиторий шаблона:** https://github.com/thebtf/openclaw-unraid
- **Руководство по памяти:** [`docs/MEMORY-SETUP.ru.md`](docs/MEMORY-SETUP.ru.md)

## Лицензия <a id="лицензия"></a>

[MIT](LICENSE). OpenClaw распространяется под лицензией MIT — см. [репозиторий OpenClaw](https://github.com/openclaw/openclaw).

## Как работает бутстрап

Бутстрап **идемпотентен** — запускается при каждом старте контейнера и обновляет только те поля, которыми управляет (`gateway.controlUi.allowedOrigins` и `models.providers.custom`). Всё, что вы меняете через Control UI (каналы, агенты, cron, инструменты), сохраняется между перезапусками.

Для мерджа используется нативный CLI `openclaw config set --batch-json`, поэтому валидацию схемы выполняет сам OpenClaw: неверный `CUSTOM_LLM_API_TYPE`, отсутствующий `CUSTOM_LLM_MODEL_ID`, некорректные origins — всё это обнаруживается с понятной ошибкой до запуска шлюза.

### Зачем base64 в PostArgs?

Раннер шаблонов Unraid удаляет символы `<` и `>` из `PostArgs` как защитную меру. Это ломает любой inline-скрипт, использующий сравнения (`i<=NF`), перенаправления (`> file`) или stderr (`>&2`). В алфавите base64 ни одного из этих символов нет, поэтому скрипт проходит без искажений.

Сам бутстрап находится в [`scripts/bootstrap.sh`](scripts/bootstrap.sh). При запуске контейнера точка входа выполняет `/bin/sh -c "echo BASE64 | base64 -d | /bin/sh"`, декодируя и запуская скрипт.

### Модификация бутстрапа

Если вы форкаете этот шаблон и редактируете `scripts/bootstrap.sh`, пересоздайте base64:

```bash
base64 -w0 scripts/bootstrap.sh
```

Замените длинную строку между `echo ` и ` | base64 -d` в `openclaw.xml` новым значением.

## Благодарности <a id="благодарности"></a>

- **Команда OpenClaw** — Peter Steinberger ([@steipete](https://twitter.com/steipete)) и контрибьюторы
- **Оригинальный шаблон CA** — [@jdhill777](https://github.com/jdhill777)
- **Этот форк** — [@thebtf](https://github.com/thebtf)
- **Протестировано на** — Unraid 7.x

---

**Вопросы?** Откройте issue или присоединяйтесь к [Discord OpenClaw](https://discord.gg/clawd).
