import dotenv from 'dotenv';
import { bot } from '../src/bot';

dotenv.config();

(async () => {
  try {
    const url = process.env.WEBHOOK_URL;
    if (!url) throw new Error('WEBHOOK_URL не задан');

    await bot.telegram.setWebhook(`${url}/api/webhook`);
    console.log(`Webhook set to: ${url}/api/webhook`);
  } catch (err) {
    console.error('Failed to set webhook:', err);
  }
})();