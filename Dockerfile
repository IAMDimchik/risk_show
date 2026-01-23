FROM node:18-alpine

WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package.json ./
RUN npm install --production

# Копируем остальные файлы
COPY server.js ./
COPY config.json ./

# Открываем порт
EXPOSE 3000

# Используем node для запуска приложения
CMD ["node", "server.js"]
