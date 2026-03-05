const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { createDataCollector } = require('./dataCollector');
const { registerChartRoutes } = require('./chartRoutes');

// Загрузка конфигурации
// Путь к конфигу можно задать через переменную окружения CONFIG_PATH
// По умолчанию используется config/config1.json
const configPath = process.env.CONFIG_PATH || path.join(__dirname, 'config', 'config1.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
console.log(`Loading config from: ${configPath}`);

const app = express();

// CORS - разрешаем запросы отовсюду
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Инициализация сборщика данных и истории
const {
  historyRootDir,
  startPolling,
  stopPolling,
  getAggregatedData
} = createDataCollector(config);

// (Сбор данных и история реализованы в dataCollector)

// Роуты для графиков (баланс/эквити, виртуальные счета и т.п.)
registerChartRoutes(app, { historyRootDir });

// HTTP endpoint для получения агрегированных данных
app.get('/api/risk/stats', (req, res) => {
  res.json(getAggregatedData());
});

// HTTP endpoint для получения данных конкретного сервера
app.get('/api/risk/stats/:serverName', (req, res) => {
  const serverName = req.params.serverName;
  const data = getAggregatedData();
  if (data.servers[serverName]) {
    res.json(data.servers[serverName]);
  } else {
    res.status(404).json({ error: 'Server not found' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Graceful shutdown
let server = null;

function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}, starting graceful shutdown...`);
  
  stopPolling();
  
  if (server) {
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
    
    // Принудительное завершение через 10 секунд
    setTimeout(() => {
      console.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

// Обработка сигналов завершения
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Обработка необработанных ошибок
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

// Запуск сервера
const PORT = config.port || 3000;
server = app.listen(PORT, () => {
  console.log(`Risk aggregation server started on port ${PORT}`);
  startPolling();
});
