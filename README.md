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

Отредактируйте `config.json`:

```json
{
  "port": 3000,
  "pollInterval": 1000,
  "servers": [
    {
      "name": "server1",
      "url": "http://localhost:8080"
    }
  ],
  "requestTimeout": 5000
}
```

## Запуск

```bash
npm start
```

## Docker

### Сборка образа

```bash
docker build -t risk-show .
```

### Запуск контейнера

```bash
docker run -d -p 3000:3000 --name risk-show risk-show
```

### Остановка контейнера (graceful shutdown)

```bash
docker stop risk-show
```

## API

- `GET /api/risk/stats` - получить агрегированную статистику по всем серверам
- `GET /api/risk/stats/:serverName` - получить статистику конкретного сервера
- `GET /health` - health check

Примеры запросов и ответов см. в папке `examples/api/`.
