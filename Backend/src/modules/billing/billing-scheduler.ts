import type { WebSocketGateway } from '../../ws/gateway';
import { expireDueTrials } from './billing.service';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const TICK_MS = 60 * 60 * 1000; // hourly is plenty for a 14-day trial window
let timer: ReturnType<typeof setInterval> | null = null;

export function startBillingScheduler(wsGateway: WebSocketGateway): void {
  if (timer) return;
  const tick = () => expireDueTrials(wsGateway).catch((err) => logger.error({ err }, '[billing] scheduler tick failed'));
  timer = setInterval(tick, TICK_MS);
  tick(); // catch anything due since the last restart
  logger.info('[billing] scheduler started');
}

export function stopBillingScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
