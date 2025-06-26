import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';

dotenv.config();

const token = process.env.BOT_TOKEN;
const mode = process.env.MODE || 'production';

if (!token) {
  throw new Error('BOT_TOKEN не найден');
}

export const bot = new Telegraf(token);

bot.start((ctx) => ctx.reply('Привет! Я бот!'));

if (mode === 'local') {
  bot.launch();
  console.log('Бот запущен в режиме polling');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}