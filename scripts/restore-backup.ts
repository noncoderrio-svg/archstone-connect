// Unpacks an encrypted backup into an empty folder: npm run restore-backup -- <file> <folder>
import { existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { restoreBackup } from '../server/services/backup.ts';

const [file, folder] = process.argv.slice(2);
if (!file || !folder) {
  console.error('Usage: npm run restore-backup -- <backup file> <empty folder>');
  process.exit(1);
}
if (existsSync(folder) && readdirSync(folder).length) {
  console.error('Choose an empty folder, so nothing gets overwritten.');
  process.exit(1);
}

const prompt = createInterface({ input: process.stdin, output: process.stdout });
const passphrase = process.env.BACKUP_PASSPHRASE ?? await prompt.question('Backup passphrase: ');
prompt.close();

try {
  const files = await restoreBackup(file, passphrase, folder);
  console.log(`Restored ${files.length} files to ${folder}. Point DB_PATH at archstone-connect.db in that folder to start from it.`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
