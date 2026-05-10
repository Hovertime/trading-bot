const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// CORS для браузерних запитів (залишено з попередньої версії)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT             = process.env.PORT || 3000;
const ACCOUNT_MODE     = (process.env.ACCOUNT_MODE || 'demo').toLowerCase(); // 'demo' | 'real'
const BYBIT_API_KEY    = process.env.BYBIT_API_KEY || '';
const BYBIT_API_SECRET = process.env.BYBIT_API_SECRET || '';
const BYBIT_DEMO_API_KEY    = process.env.BYBIT_DEMO_API_KEY || '';
const BYBIT_DEMO_API_SECRET = process.env.BYBIT_DEMO_API_SECRET || '';
const WEBHOOK_SECRET   = process.env.WEBHOOK_SECRET || '';
const BOT_TOKEN        = process.env.BOT_TOKEN || '';
const CHAT_ID          = process.env.CHAT_ID || '';

const BYBIT_ENDPOINTS = {
  demo: 'https://api-demo.bybit.com',
  real: 'https://api.bybit.com',
};

// ─── Logging ─────────────────────────────────────────────────────────────────

const logBuffer = [];
function log(level, ...args) {
  const ts  = new Date().toISOString();
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const line = `${ts} [${level.toUpperCase()}] ${msg}`;
  console.log(line);
  logBuffer.push(line);
  if (logBuffer.length > 500) logBuffer.shift();
}

// ─── In-memory state (для J-логіки: ботовий vs ручний SL) ────────────────────

const state = {
  botSL: { LONG: null, SHORT: null },  // останній SL, який САМ бот поставив
};

// ─── Bybit API helpers ───────────────────────────────────────────────────────

function getCreds() {
  if (ACCOUNT_MODE === 'real') {
    return { key: BYBIT_API_KEY, secret: BYBIT_API_SECRET };
  }
  return { key: BYBIT_DEMO_API_KEY, secret: BYBIT_DEMO_API_SECRET };
}

function bybitSign(secret, ts, key, recvWin, payloadStr) {
  return crypto.createHmac('sha256', secret)
               .update(`${ts}${key}${recvWin}${payloadStr}`)
               .digest('hex');
}

async function bybitRequest(method, path, params = {}) {
  const { key, secret } = getCreds();
  if (!key || !secret) throw new Error(`No API credentials for mode "${ACCOUNT_MODE}"`);

  const ts       = Date.now().toString();
  const recvWin  = '5000';
  const base     = BYBIT_ENDPOINTS[ACCOUNT_MODE];

  let url, body, signedPayload;

  if (method === 'GET') {
    const query = new URLSearchParams(params).toString();
    url           = `${base}${path}${query ? `?${query}` : ''}`;
    body          = undefined;
    signedPayload = query;
  } else {
    body          = JSON.stringify(params);
    url           = `${base}${path}`;
    signedPayload = body;
  }

  const sign = bybitSign(secret, ts, key, recvWin, signedPayload);
  const headers = {
    'X-BAPI-API-KEY':     key,
    'X-BAPI-SIGN':        sign,
    'X-BAPI-TIMESTAMP':   ts,
    'X-BAPI-RECV-WINDOW': recvWin,
  };
  if (method !== 'GET') headers['Content-Type'] = 'application/json';

  const resp = await fetch(url, { method, headers, body });
  const data = await resp.json();
  log('debug', `Bybit ${method} ${path} retCode=${data.retCode} retMsg="${data.retMsg}"`);
  return data;
}

// Public endpoint (no auth) — markPrice
async function getMarkPrice(symbol) {
  const url = `${BYBIT_ENDPOINTS[ACCOUNT_MODE]}/v5/market/tickers?category=linear&symbol=${symbol}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.retCode !== 0) throw new Error(`getMarkPrice: ${data.retMsg}`);
  return parseFloat(data.result.list[0].markPrice);
}

async function getWalletBalance() {
  const data = await bybitRequest('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
  if (data.retCode !== 0) throw new Error(`getWalletBalance: ${data.retMsg}`);
  const usdt = data.result?.list?.[0]?.coin?.find(c => c.coin === 'USDT');
  if (!usdt) throw new Error('USDT coin not found in unified balance');
  return parseFloat(usdt.walletBalance);
}

async function getPositions(symbol) {
  // повертає всі активні позиції (size > 0) для символу
  const data = await bybitRequest('GET', '/v5/position/list', { category: 'linear', symbol });
  if (data.retCode !== 0) throw new Error(`getPositions: ${data.retMsg}`);
  return (data.result?.list || []).filter(p => parseFloat(p.size) > 0);
}

async function getPositionBySide(symbol, side) {
  // side: 'LONG' | 'SHORT'
  const positionIdx = side === 'LONG' ? 1 : 2;
  const positions = await getPositions(symbol);
  return positions.find(p => Number(p.positionIdx) === positionIdx) || null;
}

async function setLeverage(symbol, leverage) {
  const lev = String(leverage);
  const data = await bybitRequest('POST', '/v5/position/set-leverage', {
    category: 'linear',
    symbol,
    buyLeverage:  lev,
    sellLeverage: lev,
  });
  // 110043 = "leverage not modified" — це OK, не помилка
  if (data.retCode !== 0 && data.retCode !== 110043) {
    throw new Error(`setLeverage: ${data.retMsg}`);
  }
  return data;
}

async function placeOrder({ symbol, side, qty, positionIdx, stopLoss, takeProfit, reduceOnly }) {
  const payload = {
    category:    'linear',
    symbol,
    side,                                 // 'Buy' | 'Sell'
    orderType:   'Market',
    qty:         String(qty),
    positionIdx,                          // 0=one-way, 1=Buy hedge, 2=Sell hedge
  };
  if (stopLoss)   { payload.stopLoss   = String(stopLoss);   payload.slTriggerBy = 'MarkPrice'; }
  if (takeProfit) { payload.takeProfit = String(takeProfit); payload.tpTriggerBy = 'MarkPrice'; }
  if (reduceOnly) { payload.reduceOnly = true; }
  return bybitRequest('POST', '/v5/order/create', payload);
}

async function closePosition(pos) {
  const closeSide = pos.side === 'Buy' ? 'Sell' : 'Buy';
  return placeOrder({
    symbol:      pos.symbol,
    side:        closeSide,
    qty:         pos.size,
    positionIdx: Number(pos.positionIdx),
    reduceOnly:  true,
  });
}

async function cancelAllOrders(symbol) {
  return bybitRequest('POST', '/v5/order/cancel-all', { category: 'linear', symbol });
}

async function updateStopLoss(symbol, side, newSL) {
  const positionIdx = side === 'LONG' ? 1 : 2;
  return bybitRequest('POST', '/v5/position/trading-stop', {
    category:    'linear',
    symbol,
    stopLoss:    String(newSL),
    slTriggerBy: 'MarkPrice',
    positionIdx,
  });
}

// ─── Quantity rounding (BTCUSDT step = 0.001) ────────────────────────────────

function roundQty(symbol, qty) {
  if (symbol.startsWith('BTC'))   return Math.floor(qty * 1000) / 1000;
  if (symbol.startsWith('ETH'))   return Math.floor(qty * 100)  / 100;
  return Math.floor(qty * 10) / 10;
}

// ─── Telegram (з попередньої версії) ─────────────────────────────────────────

async function sendTelegramMessage(text) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: CHAT_ID, text }),
    });
    if (!resp.ok) log('warn', `Telegram error: ${resp.status}`);
  } catch (e) {
    log('warn', `Telegram failed: ${e.message}`);
  }
}

// ─── Webhook handlers ────────────────────────────────────────────────────────

async function handleEntry({ side, ticker, sl, tp, risk_pct }) {
  log('info', `[ENTRY] ${side} ${ticker} sl=${sl} tp=${tp} risk_pct=${risk_pct}`);

  // 1. Replace logic — закриваємо будь-які існуючі позиції та pending ордери
  const existing = await getPositions(ticker);
  for (const p of existing) {
    log('info', `Closing existing: side=${p.side} size=${p.size} positionIdx=${p.positionIdx}`);
    await closePosition(p);
  }
  if (existing.length > 0) await cancelAllOrders(ticker);
  state.botSL.LONG  = null;
  state.botSL.SHORT = null;

  // 2. Live balance & price
  const balance   = await getWalletBalance();
  const livePrice = await getMarkPrice(ticker);
  log('info', `Wallet balance: ${balance} USDT  |  Live price: ${livePrice}`);

  // 3. Risk-based qty (та сама формула, що в Pine)
  const riskMoney   = balance * (risk_pct / 100);
  const riskPerUnit = side === 'LONG' ? livePrice - sl : sl - livePrice;
  if (riskPerUnit <= 0) throw new Error(`Invalid risk per unit: ${riskPerUnit}`);

  const rawQty = riskMoney / riskPerUnit;
  const qty    = roundQty(ticker, rawQty);
  if (qty <= 0) throw new Error(`Computed qty too small: ${rawQty}`);
  log('info', `Qty: ${qty} (riskMoney=${riskMoney.toFixed(2)}, riskPerUnit=${riskPerUnit.toFixed(2)})`);

  // 4. Leverage = ceil(notional / balance) + 1 (запас 1x)
  const notional    = qty * livePrice;
  const requiredLev = Math.ceil(notional / balance) + 1;
  const leverage    = Math.min(Math.max(requiredLev, 1), 100); // clamp [1..100]
  log('info', `Setting leverage: ${leverage}x (notional=${notional.toFixed(2)})`);
  await setLeverage(ticker, leverage);

  // 5. Place market order with SL/TP
  const positionIdx = side === 'LONG' ? 1 : 2;
  const orderSide   = side === 'LONG' ? 'Buy' : 'Sell';
  const result = await placeOrder({
    symbol:      ticker,
    side:        orderSide,
    qty,
    positionIdx,
    stopLoss:    sl,
    takeProfit:  tp,
  });
  if (result.retCode !== 0) throw new Error(`Order failed: ${result.retMsg}`);

  // 6. Update state
  state.botSL[side] = sl;

  // 7. Telegram
  await sendTelegramMessage(
    `🟢 ENTRY ${side} ${ticker}\n` +
    `Price: ${livePrice}\n` +
    `Qty: ${qty} (lev ${leverage}x)\n` +
    `SL: ${sl} | TP: ${tp}\n` +
    `Balance: ${balance.toFixed(2)} USDT [${ACCOUNT_MODE}]`
  );

  log('info', `[ENTRY done] orderId=${result.result?.orderId}`);
}

async function handleExit({ ticker }) {
  log('info', `[EXIT] ${ticker}`);

  const positions = await getPositions(ticker);
  if (positions.length === 0) {
    log('info', `No open position for ${ticker}, nothing to close`);
    await sendTelegramMessage(`ℹ️ EXIT ${ticker}: no position to close [${ACCOUNT_MODE}]`);
    return;
  }

  for (const p of positions) {
    log('info', `Closing: side=${p.side} size=${p.size} positionIdx=${p.positionIdx}`);
    await closePosition(p);
  }
  await cancelAllOrders(ticker);

  state.botSL.LONG  = null;
  state.botSL.SHORT = null;

  await sendTelegramMessage(`🔴 EXIT ${ticker}: closed ${positions.length} position(s) [${ACCOUNT_MODE}]`);
  log('info', `[EXIT done] closed ${positions.length} position(s)`);
}

async function handleSlUpdate({ side, ticker, new_sl }) {
  log('info', `[SL_UPDATE] ${side} ${ticker} new_sl=${new_sl}`);

  const pos = await getPositionBySide(ticker, side);
  if (!pos) {
    log('warn', `No ${side} position for ${ticker}, skipping SL update`);
    return;
  }

  const exchangeSL = parseFloat(pos.stopLoss) || null;
  let   botSL      = state.botSL[side];

  // Reconcile after restart: state втрачено, але exchange має SL — припускаємо ботовий
  if (botSL === null && exchangeSL !== null) {
    log('info', `Reconcile: state was empty, adopting exchange SL ${exchangeSL} as bot's`);
    state.botSL[side] = exchangeSL;
    botSL = exchangeSL;
  }

  // Manual override detection (J-логіка)
  if (exchangeSL !== null && botSL !== null && Math.abs(exchangeSL - botSL) > 0.01) {
    log('warn', `Manual override: exchange SL ${exchangeSL} != bot's ${botSL}, skipping`);
    await sendTelegramMessage(
      `⚠️ ${side} ${ticker}: manual SL detected (${exchangeSL}), skipping bot update to ${new_sl} [${ACCOUNT_MODE}]`
    );
    return;
  }

  // Update SL
  const result = await updateStopLoss(ticker, side, new_sl);
  if (result.retCode !== 0) throw new Error(`SL update failed: ${result.retMsg}`);

  state.botSL[side] = new_sl;
  log('info', `SL updated: ${botSL ?? '?'} → ${new_sl}`);

  await sendTelegramMessage(`🔄 SL ${side} ${ticker}: ${botSL ?? '?'} → ${new_sl} [${ACCOUNT_MODE}]`);
}

// ─── Webhook dispatcher ──────────────────────────────────────────────────────

async function processWebhook(payload) {
  const { action } = payload;
  log('info', `Processing ${action}: ${JSON.stringify(payload)}`);

  if      (action === 'ENTRY')     await handleEntry(payload);
  else if (action === 'EXIT')      await handleExit(payload);
  else if (action === 'SL_UPDATE') await handleSlUpdate(payload);
  else                             log('warn', `Unknown action: ${action}`);
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.json({
    status:       'ok',
    time:         new Date().toISOString(),
    account_mode: ACCOUNT_MODE,
    bot_state:    state.botSL,
  });
});

app.get('/test', async (req, res) => {
  try {
    const text = req.query.text || 'TEST';
    await sendTelegramMessage(text);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Legacy Telegram-relay (зворотна сумісність — старі сервіси можуть туди слати)
app.post('/signal', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ ok: false, error: 'text is required' });
    }
    await sendTelegramMessage(text);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Main webhook endpoint — TradingView -> Bybit
app.post('/webhook', (req, res) => {
  const payload = req.body || {};

  // 1. Auth
  if (payload.secret !== WEBHOOK_SECRET || !WEBHOOK_SECRET) {
    log('warn', `Invalid webhook secret (received "${payload.secret}")`);
    return res.status(403).json({ error: 'Invalid secret' });
  }

  // 2. Validate action
  const action = payload.action;
  if (!['ENTRY', 'EXIT', 'SL_UPDATE'].includes(action)) {
    log('warn', `Bad action: ${action}`);
    return res.status(400).json({ error: `Unknown action: ${action}` });
  }

  // 3. Respond fast (TradingView має короткий timeout)
  res.json({ status: 'received', action });

  // 4. Process in background
  processWebhook(payload).catch(err => {
    log('error', `Webhook processing failed: ${err.message}`);
    sendTelegramMessage(`❌ ERROR: ${err.message} [${ACCOUNT_MODE}]`);
  });
});

app.get('/logs', (_req, res) => {
  res.json({ lines: logBuffer.slice(-200) });
});

app.get('/history', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'BTCUSDT';
    const limit  = parseInt(req.query.limit || '50', 10);
    const data = await bybitRequest('GET', '/v5/position/closed-pnl', {
      category: 'linear',
      symbol,
      limit:    String(limit),
    });
    if (data.retCode !== 0) throw new Error(data.retMsg);

    const trades = data.result?.list || [];
    const pnls   = trades.map(t => parseFloat(t.closedPnl || 0));
    const total  = pnls.reduce((s, p) => s + p, 0);
    const wins   = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p < 0);

    const formatted = trades.map(t => ({
      time:   new Date(parseInt(t.updatedTime || 0, 10)).toISOString(),
      side:   t.side,
      qty:    t.qty,
      entry:  t.avgEntryPrice,
      exit:   t.avgExitPrice,
      pnl:    parseFloat(t.closedPnl || 0).toFixed(4),
      status: parseFloat(t.closedPnl || 0) > 0 ? 'WIN' : 'LOSS',
    }));

    const stats = {
      total_trades: pnls.length,
      total_pnl:    total.toFixed(4),
      wins:         wins.length,
      losses:       losses.length,
      win_rate:     pnls.length ? ((wins.length / pnls.length) * 100).toFixed(1) : 0,
      avg_win:      wins.length   ? (wins.reduce((s, w) => s + w, 0) / wins.length).toFixed(4)   : 0,
      avg_loss:     losses.length ? (losses.reduce((s, l) => s + l, 0) / losses.length).toFixed(4) : 0,
    };

    res.json({ trades: formatted, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  log('info', `Server started on port ${PORT}, mode=${ACCOUNT_MODE}`);
  if (!WEBHOOK_SECRET) log('warn', 'WEBHOOK_SECRET is not set — /webhook will reject all requests');
  if (!BYBIT_DEMO_API_KEY && ACCOUNT_MODE === 'demo') log('warn', 'BYBIT_DEMO_API_KEY is missing');
  if (!BYBIT_API_KEY      && ACCOUNT_MODE === 'real') log('warn', 'BYBIT_API_KEY is missing');
});

