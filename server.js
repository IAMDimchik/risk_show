const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// Загрузка конфигурации
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const app = express();

// CORS - разрешаем запросы отовсюду
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Хранилище агрегированных данных
let aggregatedData = {
  timestamp: null,
  servers: {},
  summary: {
    total_servers: 0,
    active_servers: 0,
    total_start_day_balance: 0,
    total_day_profit: 0,
    total_deals_count: 0,
    servers_with_limit_reached: 0,
    servers_with_close_trading: 0
  }
};

// Функция для запроса данных с сервера
async function fetchRiskStats(server) {
  try {
    const response = await axios.post(
      server.url,
      { cmd: 'risk_stats' },
      {
        timeout: config.requestTimeout,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    return {
      server: server.name,
      url: server.url,
      status: 'ok',
      data: response.data,
      error: null
    };
  } catch (error) {
    return {
      server: server.name,
      url: server.url,
      status: 'error',
      data: null,
      error: error.message
    };
  }
}

// Функция для агрегации данных
function aggregateData(serverResults) {
  const summary = {
    total_servers: serverResults.length,
    active_servers: 0,
    total_start_day_balance: 0,
    total_day_profit: 0,
    total_deals_count: 0,
    servers_with_limit_reached: 0,
    servers_with_close_trading: 0,
    total_max_daily_loss: 0,
    total_current_loss: 0
  };

  const servers = {};

  serverResults.forEach(result => {
    servers[result.server] = result;

    if (result.status === 'ok' && result.data && result.data.status === 'ok' && result.data.stats) {
      const stats = result.data.stats;
      summary.active_servers++;
      
      if (stats.start_day_balance) {
        summary.total_start_day_balance += stats.start_day_balance;
      }
      if (stats.day_profit !== undefined) {
        summary.total_day_profit += stats.day_profit;
      }
      if (stats.deals_count) {
        summary.total_deals_count += stats.deals_count;
      }
      if (stats.limit_reached) {
        summary.servers_with_limit_reached++;
      }
      if (stats.close_trading) {
        summary.servers_with_close_trading++;
      }
      if (stats.max_daily_loss) {
        summary.total_max_daily_loss += stats.max_daily_loss;
      }
      if (stats.current_loss !== undefined) {
        summary.total_current_loss += stats.current_loss;
      }
    }
  });

  return {
    timestamp: new Date().toISOString(),
    servers,
    summary
  };
}

// Функция для опроса всех серверов
async function pollServers() {
  try {
    const promises = config.servers.map(server => fetchRiskStats(server));
    const results = await Promise.all(promises);
    aggregatedData = aggregateData(results);
    console.log(`[${new Date().toISOString()}] Polled ${results.length} servers, ${aggregatedData.summary.active_servers} active`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error polling servers:`, error.message);
  }
}

// Интервал для опроса серверов
let pollIntervalId = null;

// Запуск опроса
function startPolling() {
  // Первый опрос сразу
  pollServers();
  
  // Затем каждую секунду
  pollIntervalId = setInterval(pollServers, config.pollInterval);
  console.log(`Started polling servers every ${config.pollInterval}ms`);
}

// Остановка опроса
function stopPolling() {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
    console.log('Stopped polling servers');
  }
}

// HTTP endpoint для получения агрегированных данных
app.get('/api/risk/stats', (req, res) => {
  res.json(aggregatedData);
});

// HTTP endpoint для получения данных конкретного сервера
app.get('/api/risk/stats/:serverName', (req, res) => {
  const serverName = req.params.serverName;
  if (aggregatedData.servers[serverName]) {
    res.json(aggregatedData.servers[serverName]);
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
