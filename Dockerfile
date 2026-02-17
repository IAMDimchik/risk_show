FROM node:18-alpine

WORKDIR /app

# Копируем package.json и устанавливаем зависимости
# server.js и config.json будут монтироваться через volume
COPY package.json ./
RUN npm install --production

# Открываем порт (порт настраивается в config.json)
EXPOSE 23000

# Используем node для запуска приложения
CMD ["node", "server.js"]
