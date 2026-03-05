const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Создаёт сборщик данных и логгер истории баланса/эквити
function createDataCollector(config) {
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
      total_date_commission: 0,
      total_max_day_profit: 0,
      total_max_day_loss: 0
    }
  };

  // Директория для хранения исторических данных баланса/эквити
  // Можно переопределить через переменную окружения HISTORY_DIR
  const historyRootDir = process.env.HISTORY_DIR || path.join(__dirname, 'data');

  // Карта "имя сервера -> группа" из конфига
  const serverGroupMap = {};
  // Карта "имя сервера -> порядковый номер" для сортировки
  const serverOrderMap = {};
  if (Array.isArray(config.servers)) {
    config.servers.forEach((s, index) => {
      if (s && typeof s.name === 'string') {
        // s.group задаётся в конфиге, если нужно объединять счета по группам
        serverGroupMap[s.name] = s.group || 'Default';
        // Порядковый номер сервера в конфиге
        serverOrderMap[s.name] = index;
      }
    });
  }

  // Логирование изменений баланса и эквити по каждому счёту
  function logBalanceEquityChanges(prevAggregated, nextAggregated) {
    if (!nextAggregated || !nextAggregated.servers) {
      return;
    }

    // Убедимся, что корневая папка существует
    try {
      if (!fs.existsSync(historyRootDir)) {
        fs.mkdirSync(historyRootDir, { recursive: true });
      }
    } catch (e) {
      console.error('Failed to ensure history root dir:', e.message);
      return;
    }

    Object.values(nextAggregated.servers).forEach(serverEntry => {
      if (
        !serverEntry ||
        !serverEntry.data ||
        serverEntry.data.status !== 'ok' ||
        !serverEntry.data.stats
      ) {
        return;
      }

      const stats = serverEntry.data.stats;

      // Номер счёта
      const account = stats.account;
      if (account === undefined || account === null) {
        return;
      }

      // Предыдущее значение для сравнения
      const prevServerEntry =
        prevAggregated && prevAggregated.servers
          ? prevAggregated.servers[serverEntry.server]
          : null;
      const prevStats =
        prevServerEntry && prevServerEntry.data && prevServerEntry.data.stats
          ? prevServerEntry.data.stats
          : null;

      const prevBalance = prevStats ? prevStats.current_balance : undefined;
      const prevEquity = prevStats ? prevStats.current_equity : undefined;
      const newBalance = stats.current_balance;
      const newEquity = stats.current_equity;

      if (
        newBalance === undefined &&
        newEquity === undefined
      ) {
        return;
      }

      // Время для записи
      const isoNow = new Date().toISOString();

      // Определяем "день" файла: используем локальное время сервера
      const dateKey = isoNow.slice(0, 10); // YYYY-MM-DD

      const accountDir = path.join(historyRootDir, String(account));
      const filePath = path.join(accountDir, `${dateKey}.csv`);

      // Проверяем, существует ли файл за текущий день
      const fileExistsForToday = fs.existsSync(filePath);

      // Если ни баланс, ни эквити не изменились, запись не делаем
      // НО: если файла за сегодня ещё нет - пишем в любом случае (начало дня)
      const balanceChanged =
        prevBalance === undefined || prevBalance !== newBalance;
      const equityChanged =
        prevEquity === undefined || prevEquity !== newEquity;

      if (!balanceChanged && !equityChanged && fileExistsForToday) {
        return;
      }

      try {
        if (!fs.existsSync(accountDir)) {
          fs.mkdirSync(accountDir, { recursive: true });
        }

        // Обновляем метаданные счёта (номер счёта, имя сервера, группа, порядок)
        const groupName = serverGroupMap[serverEntry.server] || 'Default';
        const orderIndex = serverOrderMap[serverEntry.server];
        // Используем порт для группировки: счета из конфига с меньшим портом идут первыми
        // Порядок = порт * 1000 + индекс в конфиге
        const configPort = config.port || 0;
        const fullOrder = configPort * 1000 + (orderIndex !== undefined ? orderIndex : 999);
        const metaPath = path.join(accountDir, 'meta.json');
        try {
          const meta = {
            account,
            server: serverEntry.server,
            group: groupName,
            order: fullOrder
          };
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), { encoding: 'utf8' });
        } catch (e) {
          console.error(
            `Failed to write meta for account ${account}:`,
            e.message
          );
        }

        const row = [
          isoNow,
          serverEntry.server,
          account,
          newBalance !== undefined ? newBalance : '',
          newEquity !== undefined ? newEquity : ''
        ].join(',') + '\n';

        // Добавляем заголовок, если файл создаётся впервые
        const needsHeader = !fs.existsSync(filePath);
        if (needsHeader) {
          fs.appendFileSync(
            filePath,
            'timestamp,server,account,current_balance,current_equity\n',
            { encoding: 'utf8' }
          );
        }

        fs.appendFileSync(filePath, row, { encoding: 'utf8' });
      } catch (e) {
        console.error(
          `Failed to write history for account ${account}:`,
          e.message
        );
      }
    });
  }

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
      total_date_commission: 0,
      total_max_day_profit: 0,
      total_max_day_loss: 0
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
        if (stats.max_day_profit !== undefined) {
          summary.total_max_day_profit += stats.max_day_profit;
        }
        if (stats.max_day_loss !== undefined) {
          summary.total_max_day_loss += stats.max_day_loss;
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
      const prevAggregated = aggregatedData;
      const promises = config.servers.map(server => fetchRiskStats(server));
      const results = await Promise.all(promises);
      const nextAggregated = aggregateData(results, config.servers);

      // Логируем изменения баланса/эквити по каждому счёту
      logBalanceEquityChanges(prevAggregated, nextAggregated);

      aggregatedData = nextAggregated;
      console.log(
        `[${new Date().toISOString()}] Polled ${results.length} servers, ${aggregatedData.summary.active_servers} active`
      );
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error polling servers:`, error.message);
    }
  }

  // Интервал для опроса серверов
  let pollIntervalId = null;

  function startPolling() {
    // Первый опрос сразу
    pollServers();

    // Затем с заданным интервалом
    pollIntervalId = setInterval(pollServers, config.pollInterval);
    console.log(`Started polling servers every ${config.pollInterval}ms`);
  }

  function stopPolling() {
    if (pollIntervalId) {
      clearInterval(pollIntervalId);
      pollIntervalId = null;
      console.log('Stopped polling servers');
    }
  }

  function getAggregatedData() {
    return aggregatedData;
  }

  return {
    historyRootDir,
    serverGroupMap,
    startPolling,
    stopPolling,
    getAggregatedData
  };
}

module.exports = {
  createDataCollector
};

