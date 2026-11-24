// A loopback-only, real SSH/SFTP transport backed by disposable disk files.
import { Server, utils, Connection } from 'ssh2';
import { generateKeyPairSync, createHash } from 'node:crypto';
import fs, { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { AddressInfo } from 'node:net';
const sftp = utils.sftp;

export async function sftpServer(
  root: string,
): Promise<{ port: number; fingerprint: string; close(): Promise<void> }> {
  const key = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const parsed = utils.parseKey(key);
  if (parsed instanceof Error || Array.isArray(parsed))
    throw new Error('Cannot generate test key');
  const fingerprint = createHash('sha256')
    .update(parsed.getPublicSSH())
    .digest('hex');
  const clients = new Set<Connection>();
  const server = new Server({ hostKeys: [key] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', (ctx) =>
      ctx.method === 'password' &&
      ctx.username === 'tester' &&
      ctx.password === 'test-password'
        ? ctx.accept()
        : ctx.reject(),
    );
    client.on('ready', () =>
      client.on('session', (accept) =>
        accept().on('sftp', (acceptSftp) => {
          const channel = acceptSftp();
          const handles = new Map<
            string,
            { file?: FileHandle; directory?: string; sent?: boolean }
          >();
          let sequence = 0;
          const resolve = (p: string): string => {
            const local = path.resolve(root, '.' + p);
            if (local !== root && !local.startsWith(root + path.sep))
              throw new Error('escape');
            return local;
          };
          const run = (id: number, action: () => Promise<void>): void => {
            void action().catch((e) =>
              channel.status(
                id,
                (e as NodeJS.ErrnoException).code === 'ENOENT'
                  ? sftp.STATUS_CODE.NO_SUCH_FILE
                  : sftp.STATUS_CODE.FAILURE,
              ),
            );
          };
          const attrs = async (file: string) => {
            const st = await fs.stat(file);
            return {
              mode: st.mode,
              uid: st.uid,
              gid: st.gid,
              size: st.size,
              atime: Math.floor(st.atimeMs / 1000),
              mtime: Math.floor(st.mtimeMs / 1000),
            };
          };
          channel.on('REALPATH', (id, p) =>
            run(id, async () =>
              channel.name(id, [
                {
                  filename: path.posix.resolve('/', p),
                  longname: p,
                  attrs: await attrs(resolve(p)),
                },
              ]),
            ),
          );
          for (const event of ['STAT', 'LSTAT'] as const)
            channel.on(event, (id: number, p: string) =>
              run(id, async () => channel.attrs(id, await attrs(resolve(p)))),
            );
          channel.on('OPENDIR', (id, p) =>
            run(id, async () => {
              await fs.readdir(resolve(p));
              const h = String(sequence++);
              handles.set(h, { directory: resolve(p) });
              channel.handle(id, Buffer.from(h));
            }),
          );
          channel.on('READDIR', (id, h) =>
            run(id, async () => {
              const entry = handles.get(h.toString());
              if (!entry?.directory || entry.sent) {
                channel.status(id, sftp.STATUS_CODE.EOF);
                return;
              }
              entry.sent = true;
              const names = await fs.readdir(entry.directory);
              channel.name(
                id,
                await Promise.all(
                  names.map(async (filename) => ({
                    filename,
                    longname: filename,
                    attrs: await attrs(path.join(entry.directory!, filename)),
                  })),
                ),
              );
            }),
          );
          channel.on('OPEN', (id, p, flags) =>
            run(id, async () => {
              const mode =
                flags & sftp.OPEN_MODE.WRITE
                  ? flags & sftp.OPEN_MODE.TRUNC
                    ? 'w'
                    : 'r+'
                  : 'r';
              const file = await fs.open(resolve(p), mode);
              const h = String(sequence++);
              handles.set(h, { file });
              channel.handle(id, Buffer.from(h));
            }),
          );
          channel.on('READ', (id, h, offset, len) =>
            run(id, async () => {
              const file = handles.get(h.toString())?.file;
              if (!file) throw new Error('handle');
              const b = Buffer.alloc(len);
              const { bytesRead } = await file.read(b, 0, len, offset);
              if (bytesRead) channel.data(id, b.subarray(0, bytesRead));
              else channel.status(id, sftp.STATUS_CODE.EOF);
            }),
          );
          channel.on('WRITE', (id, h, offset, data) =>
            run(id, async () => {
              const file = handles.get(h.toString())?.file;
              if (!file) throw new Error('handle');
              await file.write(data, 0, data.length, offset);
              channel.status(id, sftp.STATUS_CODE.OK);
            }),
          );
          channel.on('FSTAT', (id, h) =>
            run(id, async () => {
              const st = await handles.get(h.toString())!.file!.stat();
              channel.attrs(id, {
                size: st.size,
                mode: st.mode,
                uid: st.uid,
                gid: st.gid,
                atime: Math.floor(st.atimeMs / 1000),
                mtime: Math.floor(st.mtimeMs / 1000),
              });
            }),
          );
          channel.on('CLOSE', (id, h) =>
            run(id, async () => {
              await handles.get(h.toString())?.file?.close();
              handles.delete(h.toString());
              channel.status(id, sftp.STATUS_CODE.OK);
            }),
          );
          channel.on('MKDIR', (id, p) =>
            run(id, async () => {
              await fs.mkdir(resolve(p));
              channel.status(id, sftp.STATUS_CODE.OK);
            }),
          );
          channel.on('RMDIR', (id, p) =>
            run(id, async () => {
              await fs.rmdir(resolve(p));
              channel.status(id, sftp.STATUS_CODE.OK);
            }),
          );
          channel.on('REMOVE', (id, p) =>
            run(id, async () => {
              await fs.unlink(resolve(p));
              channel.status(id, sftp.STATUS_CODE.OK);
            }),
          );
          channel.on('RENAME', (id, from, to) =>
            run(id, async () => {
              await fs.rename(resolve(from), resolve(to));
              channel.status(id, sftp.STATUS_CODE.OK);
            }),
          );
          channel.on('EXTENDED', (id) =>
            channel.status(id, sftp.STATUS_CODE.OP_UNSUPPORTED),
          );
          channel.on('close', () => {
            for (const h of handles.values())
              void h.file?.close().catch(() => {});
          });
        }),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    fingerprint,
    close: async () => {
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
