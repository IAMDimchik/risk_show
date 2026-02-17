#!/bin/bash

echo "Остановка и удаление контейнеров..."
docker-compose down

echo "Удаление старых образов..."
docker rmi risk-show 2>/dev/null || true
docker rmi risk-show_risk-show 2>/dev/null || true
docker rmi risk-show_risk-show-1 2>/dev/null || true
docker rmi risk-show_risk-show-2 2>/dev/null || true

echo "Очистка неиспользуемых ресурсов..."
docker system prune -f

echo "Готово! Теперь можно запустить: ./start.sh или docker-compose up -d --build"
