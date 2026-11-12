// Start file for hosts that run a plain JavaScript file (such as Hostinger Web Apps).
// It loads the TypeScript server through tsx, exactly like `npm start`.
// No top-level await here: some hosts load this file with require(), which cannot wait.
import { appendFileSync } from 'node:fs';
import { register } from 'tsx/esm/api';

/** If the app cannot start, the reason is also written to startup-error.log, which you can open in the host's File Manager. */
function report(error) {
  const text = `[${new Date().toISOString()}] Archstone Connect could not start (Node ${process.version}):\n${error?.stack ?? error}\n\n`;
  console.error(text);
  try {
    appendFileSync(new URL('./startup-error.log', import.meta.url), text);
  } catch {
    // The folder is read-only; the console message above is all we can do.
  }
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  report(new Error(`Node.js ${process.version} is too old. Choose Node.js 24 (or 22.13 or newer) in the host's settings.`));
  process.exit(1);
}

register();
import('./server/index.ts').catch((error) => {
  report(error);
  process.exit(1);
});
