import { config } from './config.ts';
import { createApp } from './app.ts';
import { ensureBaseData } from './seed.ts';
import { applyConnections } from './services/connections.ts';
import { startScheduler } from './services/scheduler.ts';

/** A live system with these wrong would expose logins, so it refuses to start. */
function checkProductionSettings() {
  if (!config.production) return;
  const problems = [
    !config.appUrl.startsWith('https://') && 'APP_URL must start with https://',
    !config.secureCookies && 'SECURE_COOKIES must be true',
    config.demoMode && 'DEMO_MODE must be false',
  ].filter(Boolean);
  if (problems.length) throw new Error(`Cannot start in production: ${problems.join('; ')}.`);
}

checkProductionSettings();
applyConnections();
await ensureBaseData();
const server = createApp().listen(config.port, () => {
  console.log(config.production ? `Archstone Connect is running at ${config.appUrl}` : `Archstone Connect is running at http://localhost:${config.port}`);
  if (config.demoMode) console.log('Demo mode is on. Sample data is clearly labelled.');
});
startScheduler();

// Hosts send this before each update, so requests in progress can finish.
process.once('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
});
