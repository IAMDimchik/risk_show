const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

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

// Хранилище агрегированных данных
let aggregatedData = {
  timestamp: null,
  servers: {},
  summary: {
    total_servers: 0,
    active_servers: 0,
    total_start_day_balance: 0,
    total_current_balance: 0,
    total_day_profit: 0,
    total_deals_count: 0,
    servers_with_limit_reached: 0,
    servers_with_auto_close_on_limit: 0,
    total_max_daily_loss: 0,
    total_positions_profit: 0,
    total_max_day_balance: 0,
    total_profits_last_7_days: [0, 0, 0, 0, 0, 0, 0],
    total_start_trading_balance: 0,
    total_current_equity: 0,
    total_date_profit: 0,
    total_date_commission: 0
  }
};

// Функция для запроса данных с сервера
async function fetchRiskStats(server) {
  try {
    // Формируем запрос с параметрами даты начала торгов и стартового баланса
    const requestBody = {
      cmd: 'risk_stats'
    };
    
    // Добавляем параметр date если указан date_start_trading (MT5 использует параметр "date")
    if (server.date_start_trading) {
      requestBody.date = server.date_start_trading;
    }
    // start_trading_balance передается отдельно, если нужно
    if (server.start_trading_balance !== undefined) {
      requestBody.start_trading_balance = server.start_trading_balance;
    }
    
    const response = await axios.post(
      server.url,
      requestBody,
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
function aggregateData(serverResults, serversConfig) {
  const summary = {
    total_servers: serverResults.length,
    active_servers: 0,
    total_start_day_balance: 0,
    total_current_balance: 0,
    total_day_profit: 0,
    total_deals_count: 0,
    servers_with_limit_reached: 0,
    servers_with_auto_close_on_limit: 0,
    total_max_daily_loss: 0,
    total_positions_profit: 0,
    total_max_day_balance: 0,
    total_profits_last_7_days: [0, 0, 0, 0, 0, 0, 0],
    total_start_trading_balance: 0,
    total_current_equity: 0,
    total_date_profit: 0,
    total_date_commission: 0
  };

  const servers = {};

  serverResults.forEach(result => {
    // Находим конфигурацию сервера для добавления информации о дате начала торгов и балансе
    const serverConfig = serversConfig ? serversConfig.find(s => s.name === result.server) : null;
    
    // Добавляем информацию о конфигурации сервера в ответ
    const serverData = {
      ...result,
      config: {
        date_start_trading: serverConfig?.date_start_trading || null,
        start_trading_balance: serverConfig?.start_trading_balance !== undefined ? serverConfig.start_trading_balance : null
      }
    };
    
    servers[result.server] = serverData;

    if (result.status === 'ok' && result.data && result.data.status === 'ok' && result.data.stats) {
      const stats = result.data.stats;
      summary.active_servers++;
      
      if (stats.start_day_balance) {
        summary.total_start_day_balance += stats.start_day_balance;
      }
      if (stats.current_balance !== undefined) {
        summary.total_current_balance += stats.current_balance;
      }
      if (stats.current_equity !== undefined) {
        summary.total_current_equity += stats.current_equity;
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
      if (stats.auto_close_on_limit) {
        summary.servers_with_auto_close_on_limit++;
      }
      if (stats.max_daily_loss) {
        summary.total_max_daily_loss += stats.max_daily_loss;
      }
      if (stats.positions_profit !== undefined) {
        summary.total_positions_profit += stats.positions_profit;
      }
      if (stats.max_day_balance) {
        summary.total_max_day_balance += stats.max_day_balance;
      }
      // Агрегация истории профитов за 7 дней
      if (stats.profits_last_7_days && Array.isArray(stats.profits_last_7_days)) {
        stats.profits_last_7_days.forEach((profit, index) => {
          if (index < 7 && profit !== undefined && profit !== null) {
            summary.total_profits_last_7_days[index] += profit;
          }
        });
      }
      // Агрегация стартового баланса на дату начала торгов
      if (stats.start_trading_balance !== undefined) {
        summary.total_start_trading_balance += stats.start_trading_balance;
      }
      // Агрегация профита относительно указанной даты
      if (stats.date_profit !== undefined) {
        summary.total_date_profit += stats.date_profit;
      }
      // Агрегация комиссий относительно указанной даты
      if (stats.date_commission !== undefined) {
        summary.total_date_commission += stats.date_commission;
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
    aggregatedData = aggregateData(results, config.servers);
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
