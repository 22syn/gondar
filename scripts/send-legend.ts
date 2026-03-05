/**
 * One-time script: Send the legend (מדריך) to Telegram
 */
import { sendTelegramMessage, formatLegend } from '../src/services/telegramBot.js';
import { logger } from '../src/utils/logger.js';

async function main() {
    await sendTelegramMessage(formatLegend());
    logger.info('Legend sent to Telegram');
}

main().catch((err) => {
    logger.error(err);
    process.exit(1);
});
