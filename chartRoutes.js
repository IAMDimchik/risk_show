
const fs = require('fs');
const path = require('path');

// Виртуальные "счета" и группы для отображения
const VIRTUAL_TOTAL_ACCOUNT = 'TOTAL_SUM';
const VIRTUAL_TOTAL_GROUP = 'Суммарно';
const VIRTUAL_ALL_ACCOUNTS_ACCOUNT = 'ALL_ACCOUNTS';
const VIRTUAL_ALL_GROUP = 'Все счета';

function registerChartRoutes(app, options) {
  const { historyRootDir } = options;

  // HTTP endpoint для получения графика изменения баланса и эквити по счёту за день
  // GET /api/risk/chart/:account?date=YYYY-MM-DD
  app.get('/api/risk/chart/:account', (req, res) => {
    const account = req.params.account;
    const dateParam = req.query.date;
    const isTotalAccount = String(account) === VIRTUAL_TOTAL_ACCOUNT;
    const isAllAccountsAccount = String(account) === VIRTUAL_ALL_ACCOUNTS_ACCOUNT;

    const now = new Date();
    const defaultDate = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const dateKey = typeof dateParam === 'string' && dateParam.length === 10 ? dateParam : defaultDate;

    // Собираем список доступных счетов и групп (по директориям с данными и meta.json)
    let accountList = [];
    const accountMetaMap = {};
    const groupSet = new Set();
    let allAccountDirs = [];
    try {
      if (fs.existsSync(historyRootDir)) {
        const dirents = fs.readdirSync(historyRootDir, { withFileTypes: true });
        const accountDirs = dirents
          .filter(d => d.isDirectory())
          .map(d => d.name)
          .filter(name => /^\d+$/.test(name)); // только числовые идентификаторы счётов

        allAccountDirs = accountDirs.slice();

        accountDirs.forEach(accName => {
          const metaPath = path.join(historyRootDir, accName, 'meta.json');
          let groupName = 'Default';
          let serverName = null;
          let order = 9999; // По умолчанию в конец

          if (fs.existsSync(metaPath)) {
            try {
              const metaRaw = fs.readFileSync(metaPath, 'utf8');
              const meta = JSON.parse(metaRaw);
              if (meta && typeof meta.group === 'string') {
                groupName = meta.group;
              }
              if (meta && (typeof meta.server === 'string' || meta.server === null)) {
                serverName = meta.server;
              }
              if (meta && typeof meta.order === 'number') {
                order = meta.order;
              }
            } catch (e) {
              // игнорируем ошибки чтения/парсинга, используем значения по умолчанию
            }
          }

          accountMetaMap[accName] = {
            group: groupName,
            server: serverName,
            order: order
          };
          groupSet.add(groupName);
        });

        // Сортируем по порядку из конфига, затем по номеру счёта
        accountList = Object.keys(accountMetaMap).sort((a, b) => {
          const orderA = accountMetaMap[a].order;
          const orderB = accountMetaMap[b].order;
          if (orderA !== orderB) {
            return orderA - orderB;
          }
          return Number(a) - Number(b);
        });
      }
    } catch (e) {
      console.error('Failed to read accounts list:', e.message);
    }

    // Добавляем виртуальные счета и их группы, если есть хоть один реальный счёт
    if (accountList.length > 0) {
      accountMetaMap[VIRTUAL_TOTAL_ACCOUNT] = {
        group: VIRTUAL_TOTAL_GROUP,
        server: null
      };
      groupSet.add(VIRTUAL_TOTAL_GROUP);
      accountList.push(VIRTUAL_TOTAL_ACCOUNT);

      accountMetaMap[VIRTUAL_ALL_ACCOUNTS_ACCOUNT] = {
        group: VIRTUAL_ALL_GROUP,
        server: null
      };
      groupSet.add(VIRTUAL_ALL_GROUP);
      accountList.push(VIRTUAL_ALL_ACCOUNTS_ACCOUNT);
    }

    const groupList = Array.from(groupSet).sort();

    // Для обычного (реального) счёта проверяем наличие файла за дату
    const accountDir = path.join(historyRootDir, String(account));
    const filePath = path.join(accountDir, `${dateKey}.csv`);

    const isRealAccount = /^\d+$/.test(String(account));

    if (isRealAccount && !fs.existsSync(filePath)) {
      res.status(404).send(`Нет данных для счёта ${account} за дату ${dateKey}`);
      return;
    }

    // Проверяем наличие данных за соседние дни для навигации
    const baseDate = new Date(dateKey + 'T00:00:00Z');
    const prevDate = new Date(baseDate);
    prevDate.setUTCDate(prevDate.getUTCDate() - 1);
    const nextDate = new Date(baseDate);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);

    const toKey = d => d.toISOString().slice(0, 10);

    const prevKey = toKey(prevDate);
    const nextKey = toKey(nextDate);

    let prevExists;
    let nextExists;

    if (isTotalAccount || isAllAccountsAccount) {
      const hasForDate = (key) =>
        allAccountDirs.some(dir =>
          fs.existsSync(path.join(historyRootDir, dir, `${key}.csv`))
        );
      prevExists = hasForDate(prevKey);
      nextExists = hasForDate(nextKey);
    } else {
      prevExists = fs.existsSync(path.join(accountDir, `${prevKey}.csv`));
      nextExists = fs.existsSync(path.join(accountDir, `${nextKey}.csv`));
    }

    const timestamps = [];
    const balances = [];
    const equities = [];
    const multiAccounts = [];
    const multiBalances = [];
    const multiEquities = [];

    if (isTotalAccount) {
      // Строим суммарный график по всем счетам.
      // 1) Для каждого счёта читаем его временной ряд.
      // 2) Строим объединённый список временных меток.
      // 3) Для каждой метки берём последнее известное значение баланса/эквити по каждому счёту (forward-fill) и суммируем.

      const perAccount = []; // { id: string, ts: number[], b: (number|null)[], e: (number|null)[] }
      const allTsSet = new Set();

      allAccountDirs.forEach(dir => {
        const fp = path.join(historyRootDir, dir, `${dateKey}.csv`);
        if (!fs.existsSync(fp)) {
          return;
        }

        let content;
        try {
          content = fs.readFileSync(fp, 'utf8');
        } catch (e) {
          return;
        }

        const lines = content.trim().split('\n');
        const header = lines.shift();
        if (!header) {
          return;
        }

        const tsArr = [];
        const bArr = [];
        const eArr = [];

        lines.forEach(line => {
          const parts = line.split(',');
          if (parts.length < 5) {
            return;
          }
          const ts = parts[0];
          const balanceStr = parts[3];
          const equityStr = parts[4];

          const tMs = Date.parse(ts);
          if (Number.isNaN(tMs)) {
            return;
          }
          const t = Math.floor(tMs / 1000); // секунды

          const balance = balanceStr !== '' ? Number(balanceStr) : null;
          const equity = equityStr !== '' ? Number(equityStr) : null;

          tsArr.push(t);
          bArr.push(balance);
          eArr.push(equity);

          allTsSet.add(t);
        });

        if (tsArr.length > 0) {
          perAccount.push({ id: dir, ts: tsArr, b: bArr, e: eArr });
        }
      });

      const unionTs = Array.from(allTsSet).sort((a, b) => a - b);

      if (!unionTs.length || !perAccount.length) {
        res.status(404).send(`Нет данных для суммарного графика за дату ${dateKey}`);
        return;
      }

      // Forward-fill для каждого счёта по объединённой шкале времени и суммирование
      unionTs.forEach((t, idxTs) => {
        let sumB = 0;
        let sumE = 0;

        perAccount.forEach(acc => {
          let pointIdx = -1;

          if (idxTs === 0) {
            // Особое правило для самой первой точки:
            // для каждого счёта берём его самую первую точку (если она есть),
            // даже если её время > первой общей временной метки.
            if (acc.ts.length > 0) {
              pointIdx = 0;
            }
          } else {
            // Для всех остальных точек: обычный forward-fill
            let i = 0;
            while (i < acc.ts.length && acc.ts[i] <= t) {
              i++;
            }
            pointIdx = i - 1;
          }

          if (pointIdx >= 0) {
            const bVal = acc.b[pointIdx];
            const eVal = acc.e[pointIdx];
            if (bVal !== null && !Number.isNaN(bVal)) {
              sumB += bVal;
            }
            if (eVal !== null && !Number.isNaN(eVal)) {
              sumE += eVal;
            }
          }
        });

        timestamps.push(t);
        balances.push(sumB);
        equities.push(sumE);
      });
    } else if (isAllAccountsAccount) {
      // Режим "Все счета": строим общий временной ряд и отдельные графики по каждому счёту
      const perAccount = []; // { id: string, ts: number[], b: (number|null)[], e: (number|null)[] }
      const allTsSet = new Set();

      allAccountDirs.forEach(dir => {
        const fp = path.join(historyRootDir, dir, `${dateKey}.csv`);
        if (!fs.existsSync(fp)) {
          return;
        }

        let content;
        try {
          content = fs.readFileSync(fp, 'utf8');
        } catch (e) {
          return;
        }

        const lines = content.trim().split('\n');
        const header = lines.shift();
        if (!header) {
          return;
        }

        const tsArr = [];
        const bArr = [];
        const eArr = [];

        lines.forEach(line => {
          const parts = line.split(',');
          if (parts.length < 5) {
            return;
          }
          const ts = parts[0];
          const balanceStr = parts[3];
          const equityStr = parts[4];

          const tMs = Date.parse(ts);
          if (Number.isNaN(tMs)) {
            return;
          }
          const t = Math.floor(tMs / 1000); // секунды

          const balance = balanceStr !== '' ? Number(balanceStr) : null;
          const equity = equityStr !== '' ? Number(equityStr) : null;

          tsArr.push(t);
          bArr.push(balance);
          eArr.push(equity);

          allTsSet.add(t);
        });

        if (tsArr.length > 0) {
          perAccount.push({ id: dir, ts: tsArr, b: bArr, e: eArr });
        }
      });

      const unionTs = Array.from(allTsSet).sort((a, b) => a - b);

      if (!unionTs.length || !perAccount.length) {
        res.status(404).send(`Нет данных для всех счетов за дату ${dateKey}`);
        return;
      }

      // Сортируем счета по порядку из конфига
      perAccount.sort((a, b) => {
        const metaA = accountMetaMap[a.id] || { order: 9999 };
        const metaB = accountMetaMap[b.id] || { order: 9999 };
        if (metaA.order !== metaB.order) {
          return metaA.order - metaB.order;
        }
        return Number(a.id) - Number(b.id);
      });

      unionTs.forEach(t => {
        timestamps.push(t);
      });

      perAccount.forEach(acc => {
        const bOut = [];
        const eOut = [];
        let i = 0;
        let lastB = null;
        let lastE = null;

        unionTs.forEach(t => {
          while (i < acc.ts.length && acc.ts[i] <= t) {
            lastB = acc.b[i];
            lastE = acc.e[i];
            i++;
          }
          bOut.push(lastB);
          eOut.push(lastE);
        });

        multiAccounts.push(acc.id);
        multiBalances.push(bOut);
        multiEquities.push(eOut);
      });
    } else {
      let csvContent;
      try {
        csvContent = fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        res.status(500).send('Ошибка чтения файла данных');
        return;
      }

      const lines = csvContent.trim().split('\n');
      const header = lines.shift(); // timestamp,server,account,current_balance,current_equity
      if (!header) {
        res.status(500).send('Файл данных пуст');
        return;
      }

      lines.forEach(line => {
        const parts = line.split(',');
        if (parts.length < 5) {
          return;
        }
        const ts = parts[0];
        const balanceStr = parts[3];
        const equityStr = parts[4];

        const tMs = Date.parse(ts);
        if (Number.isNaN(tMs)) {
          return;
        }
        const t = Math.floor(tMs / 1000); // секунды

        const balance = balanceStr !== '' ? Number(balanceStr) : null;
        const equity = equityStr !== '' ? Number(equityStr) : null;

        timestamps.push(t);
        balances.push(balance);
        equities.push(equity);
      });
    }

    const chartMode = isAllAccountsAccount ? 'all' : (isTotalAccount ? 'total' : 'single');

    const pageHtml = `
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>График баланса и эквити — счёт ${account} (${dateKey})</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0b1120;
      color: #e5e7eb;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-bottom: 16px;
    }
    .toolbar button {
      background: #1f2937;
      border: 1px solid #374151;
      color: #e5e7eb;
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .toolbar button:hover {
      background: #111827;
      border-color: #4b5563;
    }
    .toolbar button:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .toolbar label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: #d1d5db;
      cursor: pointer;
    }
    .toolbar input[type="checkbox"] {
      width: 14px;
      height: 14px;
      cursor: pointer;
    }
    .toolbar select {
      background: #111827;
      border-radius: 6px;
      border: 1px solid #374151;
      color: #e5e7eb;
      padding: 4px 8px;
      font-size: 12px;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 20px;
      font-weight: 600;
    }
    .subtitle {
      margin-bottom: 16px;
      color: #9ca3af;
      font-size: 13px;
    }
    #chart {
      max-width: 100%;
      height: 480px;
    }
    .uplot {
      font-size: 11px;
    }
    .u-tooltip {
      font-family: inherit;
    }
    /* Легенда: группировка по счетам */
    .u-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 12px;
    }
    .u-series {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 4px;
      border-radius: 4px;
    }
    .u-series:hover {
      background: rgba(255,255,255,0.05);
    }
    /* Контейнер для группы серий одного счета */
    .legend-account-row {
      display: grid;
      grid-template-columns: minmax(180px, auto) 150px 150px 150px;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 4px 0;
      border-bottom: 1px solid rgba(75, 85, 99, 0.4);
    }
    .legend-account-row:last-child {
      border-bottom: none;
    }
    .legend-account-label {
      font-weight: 600;
      color: #e5e7eb;
    }
    .legend-header {
      font-weight: 600;
      color: #e5e7eb;
      padding: 4px 0;
      margin-bottom: 4px;
      border-bottom: 1px solid rgba(75, 85, 99, 0.4);
    }
    .legend-account-row .u-series {
      justify-content: flex-start;
    }
    .legend-account-row .u-value {
      min-width: 80px;
      text-align: right;
    }
    /* Подсветка региона при выделении/зуме */
    .u-select {
      background: rgba(59, 130, 246, 0.18);
      border: 1px solid rgba(59, 130, 246, 0.9);
      box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.9);
    }
  </style>
  <link rel="stylesheet" href="https://unpkg.com/uplot@1.6.30/dist/uPlot.min.css">
</head>
<body>
  <h1>Счёт ${account}</h1>
  <div class="subtitle">Баланс и эквити за ${dateKey}</div>
  <div class="toolbar">
    <label>
      Группа:
      <select id="groupSelect"></select>
    </label>
    <label>
      Счёт:
      <select id="accountSelect"></select>
    </label>
    <button id="prevDayBtn" ${prevExists ? '' : 'disabled'}>&larr; Предыдущий день</button>
    <button id="nextDayBtn" ${nextExists ? '' : 'disabled'}>Следующий день &rarr;</button>
    <button id="refreshBtn">Обновить график</button>
    <button id="resetZoomBtn">Сбросить зум</button>
    <label>
      <input type="checkbox" id="autoRefreshChk">
      Автообновление (1 раз в секунду)
    </label>
  </div>
  <div id="chart"></div>

  <script src="https://unpkg.com/uplot@1.6.30/dist/uPlot.iife.min.js"></script>
  <script>
    (function () {
      var ts = ${JSON.stringify(timestamps)};
      var balances = ${JSON.stringify(balances)};
      var equities = ${JSON.stringify(equities)};
      var mode = ${JSON.stringify(chartMode)};
      var allAccounts = ${JSON.stringify(multiAccounts)};
      var allBalances = ${JSON.stringify(multiBalances)};
      var allEquities = ${JSON.stringify(multiEquities)};

      if (!ts.length) {
        document.getElementById('chart').innerText = 'Нет точек для отображения';
        return;
      }

      // ts уже в секундах
      var xs = ts.slice();

      // Формат времени внизу графика: 24 часа, HH:MM:SS
      var fmtTime = function (unixSec) {
        var d = new Date(unixSec * 1000);
        var h = String(d.getHours()).padStart(2, '0');
        var m = String(d.getMinutes()).padStart(2, '0');
        var s = String(d.getSeconds()).padStart(2, '0');
        return h + ':' + m + ':' + s;
      };

      // Форматирование чисел по-русски: разделитель тысяч (пробел/неразрывный пробел), без копеек
      var fmtNum = function (v) {
        if (v == null || isNaN(v)) return '';
        return Math.round(Number(v)).toLocaleString('ru-RU');
      };

      // Формируем series и data в зависимости от режима
      var seriesDefs = [
        {
          // X-серия (время)
          value: function (u, v) {
            if (v == null) return '';
            return fmtTime(v);
          }
        }
      ];

      var data;

      if (mode === 'all') {
        data = [xs];

        var baseColors = ['#22c55e', '#3b82f6', '#f97316', '#ec4899', '#a855f7', '#eab308', '#06b6d4', '#16a34a', '#ef4444'];

        allAccounts.forEach(function (acc, idx) {
          var colorIdx = idx % baseColors.length;
          var baseColor = baseColors[colorIdx];

          // Вычисляем equity - balance
          var eqMinusBal = allEquities[idx].map(function (e, i) {
            var b = allBalances[idx][i];
            if (e == null || b == null) return null;
            return e - b;
          });

          data.push(allBalances[idx]);
          data.push(allEquities[idx]);
          data.push(eqMinusBal);

          seriesDefs.push({
            label: 'Б',
            stroke: baseColor,
            width: 1.5,
            _account: acc,
            value: function (u, v) {
              if (v == null) return '-';
              return fmtNum(v);
            }
          });

          seriesDefs.push({
            label: 'Э',
            stroke: baseColor,
            width: 1,
            dash: [4, 4],
            _account: acc,
            value: function (u, v) {
              if (v == null) return '-';
              return fmtNum(v);
            }
          });

          seriesDefs.push({
            label: 'E-B',
            stroke: baseColor,
            width: 1,
            dash: [2, 2],
            show: false,
            _account: acc,
            value: function (u, v) {
              if (v == null) return '-';
              return fmtNum(v);
            }
          });
        });
      } else {
        // Вычисляем equity - balance для single/total режимов
        var eqMinusBal = equities.map(function (e, i) {
          var b = balances[i];
          if (e == null || b == null) return null;
          return e - b;
        });

        data = [xs, balances, equities, eqMinusBal];

        seriesDefs.push(
          {
            label: 'Баланс',
            stroke: '#22c55e',
            width: 2,
            value: function (u, v) {
              if (v == null) return '-';
              return fmtNum(v);
            }
          },
          {
            label: 'Эквити',
            stroke: '#3b82f6',
            width: 2,
            value: function (u, v) {
              if (v == null) return '-';
              return fmtNum(v);
            }
          },
          {
            label: 'Equity-Balance',
            stroke: '#f97316',
            width: 1.5,
            dash: [3, 3],
            show: false,
            value: function (u, v) {
              if (v == null) return '-';
              return fmtNum(v);
            }
          }
        );
      }

      var opts = {
        width: document.getElementById('chart').clientWidth,
        height: 420,
        tzDate: function (ts) { return new Date(ts * 1000); },
        plugins: [
          uPlot.tooltips && uPlot.tooltips()
        ].filter(Boolean),
        cursor: {
          drag: {
            x: true,
            y: true
          }
        },
        hooks: {
          setSelect: [
            function (u) {
              var sel = u.select;
              // Если выделение слишком маленькое, игнорируем
              if (sel.width < 10 || sel.height < 10) return;

              // Получаем границы из позиции выделения
              var xMin = u.posToVal(sel.left, 'x');
              var xMax = u.posToVal(sel.left + sel.width, 'x');
              
              // Y-ось инвертирована (top = max, bottom = min)
              var yMax = u.posToVal(sel.top, 'y');
              var yMin = u.posToVal(sel.top + sel.height, 'y');

              // Устанавливаем новые границы по X и Y
              u.setScale('x', { min: xMin, max: xMax });
              u.setScale('y', { min: yMin, max: yMax });

              // Сбрасываем выделение
              u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
            }
          ]
        },
        scales: {
          x: {
            time: true,
          },
          y: {
            auto: false
          }
        },
        axes: [
          {
            stroke: '#9ca3af',
            grid: { stroke: 'rgba(55,65,81,0.6)' },
            values: function (u, vals) {
              return vals.map(fmtTime);
            }
          },
          {
            stroke: '#9ca3af',
            grid: { stroke: 'rgba(55,65,81,0.6)' },
            values: function (u, vals) {
              return vals.map(fmtNum);
            }
          }
        ],
        series: seriesDefs
      };

      // Вычисляем начальные границы Y для всех данных
      var initialYMin = Infinity;
      var initialYMax = -Infinity;
      for (var si = 1; si < data.length; si++) {
        // Проверяем, будет ли серия показана
        if (seriesDefs[si] && seriesDefs[si].show === false) continue;
        var yData = data[si];
        for (var i = 0; i < yData.length; i++) {
          var y = yData[i];
          if (y != null && !isNaN(y)) {
            if (y < initialYMin) initialYMin = y;
            if (y > initialYMax) initialYMax = y;
          }
        }
      }
      // Добавляем отступ
      var initialYPad = (initialYMax - initialYMin) * 0.05 || 1;
      initialYMin -= initialYPad;
      initialYMax += initialYPad;

      // Начальные границы X
      var initialXMin = xs[0];
      var initialXMax = xs[xs.length - 1];

      // Устанавливаем начальные границы в опциях
      opts.scales.y.range = function () { return [initialYMin, initialYMax]; };

      var u = new uPlot(opts, data, document.getElementById('chart'));

      // Устанавливаем начальные границы
      u.setScale('y', { min: initialYMin, max: initialYMax });

      // Метаданные счетов для отображения имён серверов
      var accountMeta = ${JSON.stringify(accountMetaMap)};

      // При режиме "все счета" группируем легенду по счетам (каждый счет на своей строке)
      if (mode === 'all' && allAccounts.length > 1) {
        var legend = document.querySelector('.u-legend');
        if (legend) {
          // Получаем все серии (первая - это время, пропускаем)
          var seriesElements = legend.querySelectorAll('.u-series');
          var seriesArr = Array.prototype.slice.call(seriesElements);
          
          // Первый элемент - время, оставляем его
          var timeEl = seriesArr[0];
          
          // Очищаем легенду
          legend.innerHTML = '';
          legend.appendChild(timeEl);
          
          // Группируем по 3 серии на каждый счет (Баланс, Эквити, E-B)
          for (var i = 0; i < allAccounts.length; i++) {
            var accId = allAccounts[i];
            var accMeta = accountMeta[accId];
            var serverName = (accMeta && accMeta.server) ? accMeta.server : '';
            // Формат: номер_счёта (имя_сервера) или просто номер_счёта
            var displayName = serverName ? (accId + ' (' + serverName + ')') : accId;

            var accountRow = document.createElement('div');
            accountRow.className = 'legend-account-row';
            
            var accountLabel = document.createElement('span');
            accountLabel.className = 'legend-account-label';
            accountLabel.textContent = displayName + ':';
            accountRow.appendChild(accountLabel);
            
            // 3 серии на счет: индекс = 1 + i*3, 1 + i*3 + 1, 1 + i*3 + 2
            var baseIdx = 1 + i * 3;
            for (var j = 0; j < 3; j++) {
              var idx = baseIdx + j;
              if (seriesArr[idx]) {
                accountRow.appendChild(seriesArr[idx]);
              }
            }
            
            legend.appendChild(accountRow);
          }
        }
      } else {
        // Для single/total режима добавляем заголовок с номером счёта и именем
        var legend = document.querySelector('.u-legend');
        if (legend) {
          var currentAcc = '${account}';
          var currentMeta = accountMeta[currentAcc];
          var serverName = (currentMeta && currentMeta.server) ? currentMeta.server : '';
          var displayName = serverName ? (currentAcc + ' (' + serverName + ')') : currentAcc;
          
          // Создаём заголовок легенды
          var legendHeader = document.createElement('div');
          legendHeader.className = 'legend-header';
          legendHeader.textContent = displayName;
          legend.insertBefore(legendHeader, legend.firstChild);
        }
      }

      // Авто-ресайз при изменении ширины окна
      window.addEventListener('resize', function () {
        var rect = document.getElementById('chart').getBoundingClientRect();
        u.setSize({ width: rect.width, height: 420 });
      });

      // Управление обновлением и навигацией
      var refreshBtn = document.getElementById('refreshBtn');
      var resetZoomBtn = document.getElementById('resetZoomBtn');
      var autoChk = document.getElementById('autoRefreshChk');
      var autoTimer = null;

      // Функция сброса зума к начальным границам
      function resetZoom() {
        u.setScale('x', { min: initialXMin, max: initialXMax });
        u.setScale('y', { min: initialYMin, max: initialYMax });
      }

      // Сброс зума по кнопке
      resetZoomBtn.addEventListener('click', resetZoom);

      // Сброс зума по двойному клику на график
      document.getElementById('chart').addEventListener('dblclick', resetZoom);

      function buildUrl(dateStr, accountStr) {
        var pathParts = window.location.pathname.split('/');
        // последний сегмент — текущий account
        pathParts[pathParts.length - 1] = accountStr || pathParts[pathParts.length - 1];
        var base = pathParts.join('/');
        var params = new URLSearchParams(window.location.search);
        if (dateStr) {
          params.set('date', dateStr);
        }
        return base + (params.toString() ? '?' + params.toString() : '');
      }

      refreshBtn.addEventListener('click', function () {
        window.location.reload();
      });

      autoChk.addEventListener('change', function () {
        if (autoChk.checked) {
          if (autoTimer) clearInterval(autoTimer);
          autoTimer = setInterval(function () {
            window.location.reload();
          }, 1000);
        } else {
          if (autoTimer) {
            clearInterval(autoTimer);
            autoTimer = null;
          }
        }
      });

      window.addEventListener('beforeunload', function () {
        if (autoTimer) {
          clearInterval(autoTimer);
          autoTimer = null;
        }
      });

      var prevBtn = document.getElementById('prevDayBtn');
      var nextBtn = document.getElementById('nextDayBtn');

      if (prevBtn && !prevBtn.disabled) {
        prevBtn.addEventListener('click', function () {
          window.location.href = buildUrl('${prevKey}');
        });
      }

      if (nextBtn && !nextBtn.disabled) {
        nextBtn.addEventListener('click', function () {
          window.location.href = buildUrl('${nextKey}');
        });
      }

      // Переключение между группами и счетами
      var accountSelect = document.getElementById('accountSelect');
      var groupSelect = document.getElementById('groupSelect');
      var accounts = ${JSON.stringify(accountList)};
      var groups = ${JSON.stringify(groupList)};
      var currentAccount = '${account}';
      var currentGroup = (accountMeta[currentAccount] && accountMeta[currentAccount].group) || (groups[0] || 'Default');

      // Инициализируем список групп
      if (groups.length === 0 && currentGroup) {
        groups = [currentGroup];
      }

      groups.forEach(function (g) {
        var opt = document.createElement('option');
        opt.value = g;
        opt.textContent = g;
        if (g === currentGroup) {
          opt.selected = true;
        }
        groupSelect.appendChild(opt);
      });

      function rebuildAccounts(groupName) {
        accountSelect.innerHTML = '';

        var filtered = accounts.filter(function (acc) {
          var meta = accountMeta[acc];
          var g = meta && meta.group ? meta.group : 'Default';
          return g === groupName;
        });

        if (filtered.length === 0 && currentAccount) {
          filtered = [currentAccount];
        }

        filtered.sort(function (a, b) { return Number(a) - Number(b); });

        filtered.forEach(function (acc) {
          var opt = document.createElement('option');
          opt.value = acc;
          if (acc === '${VIRTUAL_TOTAL_ACCOUNT}') {
            opt.textContent = 'Сумма по всем';
          } else if (acc === '${VIRTUAL_ALL_ACCOUNTS_ACCOUNT}') {
            opt.textContent = 'Все счета';
          } else {
            opt.textContent = acc;
          }
          if (acc === currentAccount) {
            opt.selected = true;
          }
          accountSelect.appendChild(opt);
        });
      }

      rebuildAccounts(currentGroup);

      groupSelect.addEventListener('change', function () {
        var newGroup = groupSelect.value;
        currentGroup = newGroup;
        // Перестраиваем список счетов
        rebuildAccounts(newGroup);
        var firstAcc = accountSelect.value;
        if (firstAcc && firstAcc !== currentAccount) {
          window.location.href = buildUrl('${dateKey}', firstAcc);
        }
      });

      accountSelect.addEventListener('change', function () {
        var newAcc = accountSelect.value;
        window.location.href = buildUrl('${dateKey}', newAcc);
      });
    })();
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(pageHtml);
  });
}

module.exports = {
  registerChartRoutes,
  VIRTUAL_TOTAL_ACCOUNT,
  VIRTUAL_TOTAL_GROUP,
  VIRTUAL_ALL_ACCOUNTS_ACCOUNT,
  VIRTUAL_ALL_GROUP
};

