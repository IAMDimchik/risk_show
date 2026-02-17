# Risk Show - Сервер агрегации рисков

Node.js сервер для агрегации данных о рисках с нескольких серверов.

## Возможности

- Опрос серверов раз в секунду (настраивается)
- Агрегация данных со всех серверов
- HTTP API для получения агрегированных данных
- Graceful shutdown
- Поддержка Docker

## Установка

```bash
npm install
```

## Конфигурация

Конфигурационные файлы находятся в папке `config/`. По умолчанию используется `config/config1.json`. 
Путь к конфигу можно задать через переменную окружения `CONFIG_PATH`:

```bash
CONFIG_PATH=config/config2.json npm start
```

Пример конфигурации (`config/config1.json`):

```json
{
  "port": 23000,
  "pollInterval": 1000,
  "servers": [
    {
      "name": "100$_50%",
      "url": "http://i.mt5.bmgd.xyz:43001",
      "date_start_trading": "2026.01.15",
      "start_trading_balance": 10000.00
    },
    {
      "name": "200$_25%",
      "url": "http://i.mt5.bmgd.xyz:49101",
      "date_start_trading": "2026.01.10",
      "start_trading_balance": 15000.00
    }
  ],
  "requestTimeout": 5000
}
```

**Параметры конфигурации:**

- `port` - порт HTTP сервера (по умолчанию 3000)
- `pollInterval` - интервал опроса серверов в миллисекундах (по умолчанию 1000)
- `requestTimeout` - таймаут запросов к серверам в миллисекундах (по умолчанию 5000)
- `servers` - массив серверов для опроса:
  - `name` - имя сервера (обязательно)
  - `url` - URL сервера MT5 (обязательно)
  - `date_start_trading` - дата начала торгов в формате "YYYY.MM.DD" (опционально, передается в MT5 для расчета профита с учетом комиссий)
  - `start_trading_balance` - стартовый баланс на дату начала торгов (опционально, передается в MT5)

**Примечание:** Если указан параметр `date_start_trading` (передается как `date` в запросе), MT5 вернет дополнительные поля:
- `date_profit` - профит относительно указанной даты (от начала указанного дня до текущего момента)
- `date_commission` - комиссии относительно указанной даты (от начала указанного дня до текущего момента)

Пример конфигурации см. в `examples/config_example.json`.

## Запуск

```bash
npm start
```

## Docker

### Использование Docker Compose (рекомендуется)

**Важно:** Код (`server.js`) и конфигурация (`config.json`) монтируются через volume, поэтому изменения применяются без пересборки образа.

#### Первый запуск или после изменений в зависимостях

```bash
# Установите зависимости локально (нужны для volume)
npm install

# Остановите и удалите старые контейнеры и образы (если есть)
docker-compose down
docker rmi risk-show_risk-show 2>/dev/null || true

# Соберите образ
docker-compose build

# Запуск сервера
docker-compose up -d
```

#### Очистка старых контейнеров и образов

Если у вас есть старые контейнеры или образы, которые могут конфликтовать:

**Быстрая очистка (скрипт):**
```bash
./clean-docker.sh
```

**Или вручную:**
```bash
# Остановить и удалить контейнеры из docker-compose
docker-compose down

# Удалить старый образ (если был собран вручную)
docker rmi risk-show 2>/dev/null || true

# Удалить образ из docker-compose
docker rmi risk-show_risk-show 2>/dev/null || true

# Очистить неиспользуемые образы и контейнеры (опционально)
docker system prune -f
```

#### Управление сервером

```bash
# Запуск сервера
docker-compose up -d

# Просмотр логов
docker-compose logs -f

# Остановка сервера (graceful shutdown)
docker-compose stop

# Остановка и удаление контейнера
docker-compose down

# Пересборка образа (после изменений в package.json)
docker-compose build
```

**Примечание:** После изменения `server.js` или `config.json` просто перезапустите контейнер:
```bash
docker-compose restart
```

### Ручная сборка и запуск

#### Сборка образа

```bash
docker build -t risk-show .
```

#### Запуск контейнера

```bash
docker run -d -p 23000:23000 --name risk-show risk-show
```

#### Остановка контейнера (graceful shutdown)

```bash
docker stop risk-show
```

## API

- `GET /api/risk/stats` - получить агрегированную статистику по всем серверам
- `GET /api/risk/stats/:serverName` - получить статистику конкретного сервера
- `GET /health` - health check

Примеры запросов и ответов см. в папке `examples/risk_stats/`.
