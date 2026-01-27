import 'dotenv/config';
import express from 'express';
import './bot/bot.js'; // бот буде запускатися, коли є секрет

const app = express();
const port = process.env.PORT || 8080; // Fly обов’язково використовує PORT

app.get('/', (req, res) => {
  res.send('Bot is running!');
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
