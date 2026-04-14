const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

async function sendTelegramMessage(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error('BOT_TOKEN or CHAT_ID is missing');
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text
    })
  });

  const data = await res.json();

  if (!data.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  }

  return data;
}

app.get('/', (_req, res) => {
  res.send('Telegram signal relay is running');
});

app.get('/test', async (req, res) => {
  try {
    const text = req.query.text || 'TEST';
    const result = await sendTelegramMessage(text);

    res.json({
      ok: true,
      telegram: result
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post('/signal', async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'text is required'
      });
    }

    const result = await sendTelegramMessage(text);

    res.json({
      ok: true,
      telegram: result
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
