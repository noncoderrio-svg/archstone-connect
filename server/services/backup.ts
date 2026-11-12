import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * A backup is one encrypted file: header, then AES-256-GCM over a list of
 * [name length, name, size, bytes] entries, then the authentication tag.
 * The key comes from a passphrase that is never stored, so the file is
 * unreadable to anyone without it, including this server and its host.
 */
const MAGIC = Buffer.from('ARCHBK01');
const SALT = 16;
const IV = 12;
const TAG = 16;
const CHUNK = 1024 * 1024;

const keyFrom = (passphrase: string, salt: Buffer) => scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });

/** Everything needed to rebuild the system, except older backups and first-login notes. */
function filesIn(root: string, folder = root): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? filesIn(root, path) : [path];
  });
}

async function* entries(files: { path: string; name: string }[]) {
  for (const { path, name } of files) {
    const nameBytes = Buffer.from(name.split(sep).join('/'));
    const head = Buffer.alloc(12);
    head.writeUInt32BE(nameBytes.length, 0);
    head.writeBigUInt64BE(BigInt(statSync(path).size), 4);
    yield head;
    yield nameBytes;
    yield* createReadStream(path, { highWaterMark: CHUNK });
  }
}

/** Streams the encrypted backup, so a large file does not fill the server's memory. */
export async function writeBackup(database: string, dataFolder: string, passphrase: string, target: NodeJS.WritableStream) {
  const salt = randomBytes(SALT);
  const iv = randomBytes(IV);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(passphrase, salt), iv);
  const files = [
    { path: database, name: 'archstone-connect.db' },
    { path: join(dataFolder, 'secret.key'), name: 'secret.key' },
    ...['media', 'documents'].flatMap((folder) => filesIn(join(dataFolder, folder)).map((path) => ({ path, name: relative(dataFolder, path) }))),
  ].filter((f) => existsSync(f.path));

  target.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(Readable.from(entries(files)), cipher, target, { end: false });
  target.end(cipher.getAuthTag());
  return files.length;
}

/** Restores into an empty folder. Nothing is unpacked until the whole file is proven untouched. */
export async function restoreBackup(file: string, passphrase: string, targetFolder: string) {
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  const header = Buffer.alloc(MAGIC.length + SALT + IV);
  const tag = Buffer.alloc(TAG);
  readSync(fd, header, 0, header.length, 0);
  readSync(fd, tag, 0, TAG, size - TAG);
  closeSync(fd);
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('This is not an Archstone Connect backup file.');

  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT);
  const iv = header.subarray(MAGIC.length + SALT);
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(passphrase, salt), iv);
  decipher.setAuthTag(tag);

  mkdirSync(targetFolder, { recursive: true });
  const plain = join(targetFolder, '.restore-in-progress');
  try {
    await pipeline(createReadStream(file, { start: header.length, end: size - TAG - 1 }), decipher, createWriteStream(plain));
  } catch {
    rmSync(plain, { force: true });
    throw new Error('The passphrase is wrong, or the file is damaged. Nothing was restored.');
  }

  const source = openSync(plain, 'r');
  const total = statSync(plain).size;
  const root = resolve(targetFolder);
  const restored: string[] = [];
  let at = 0;
  const read = (length: number) => {
    const buffer = Buffer.alloc(length);
    readSync(source, buffer, 0, length, at);
    at += length;
    return buffer;
  };
  while (at < total) {
    const head = read(12);
    const name = read(head.readUInt32BE(0)).toString();
    let left = Number(head.readBigUInt64BE(4));
    const path = resolve(root, name);
    if (!path.startsWith(root + sep)) throw new Error('This backup contains an unsafe file path.');
    mkdirSync(dirname(path), { recursive: true });
    const out = openSync(path, 'w');
    while (left > 0) {
      const piece = read(Math.min(left, CHUNK));
      left -= piece.length;
      let written = 0;
      while (written < piece.length) written += writeSync(out, piece, written);
    }
    closeSync(out);
    restored.push(name);
  }
  closeSync(source);
  rmSync(plain, { force: true });
  return restored;
}
