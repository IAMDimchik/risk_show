#!/bin/bash

echo "Запуск обоих экземпляров risk-show..."
docker-compose up -d --build

echo ""
echo "Проверка статуса контейнеров..."
docker-compose ps

echo ""
echo "Логи можно посмотреть командами:"
echo "  docker-compose logs -f risk-show-1"
echo "  docker-compose logs -f risk-show-2"
echo ""
echo "Экземпляры доступны на портах:"
echo "  - risk-show-1: http://localhost:23000"
echo "  - risk-show-2: http://localhost:23001"
