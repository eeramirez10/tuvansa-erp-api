import net from 'node:net';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const listenHost = process.env.MYSQL_PROXY_HOST ?? '127.0.0.1';
const listenPort = Number(process.env.MYSQL_PROXY_PORT ?? 3307);
const targetHost = process.env.MYSQL_TARGET_HOST ?? '127.0.0.1';
const targetPort = Number(process.env.MYSQL_TARGET_PORT ?? 3306);
const logPath = resolve(process.env.MYSQL_PROXY_LOG ?? 'captures/omnis-mysql.log');

mkdirSync(dirname(logPath), { recursive: true });
const log = createWriteStream(logPath, { flags: 'a' });

const record = (event: Record<string, unknown>): void => {
  log.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
};

let nextConnectionId = 1;

const proxy = net.createServer((client) => {
  const connectionId = nextConnectionId++;
  const target = net.createConnection({ host: targetHost, port: targetPort });
  let clientBuffer = Buffer.alloc(0);
  let targetBuffer = Buffer.alloc(0);

  console.log(`CONNECTED ${connectionId}`);
  record({ type: 'connection', connectionId });

  client.on('data', (chunk) => {
    clientBuffer = Buffer.concat([clientBuffer, chunk]);

    while (clientBuffer.length >= 4) {
      const payloadLength = clientBuffer.readUIntLE(0, 3);
      const packetLength = payloadLength + 4;

      if (clientBuffer.length < packetLength) {
        break;
      }

      const payload = clientBuffer.subarray(4, packetLength);
      clientBuffer = clientBuffer.subarray(packetLength);

      if (payload[0] === 0x03) {
        const sql = payload.subarray(1).toString('latin1');
        console.log(`SQL ${connectionId} ${JSON.stringify(sql)}`);
        record({ type: 'query', connectionId, sql });
      } else if (payload[0] === 0x16) {
        const sql = payload.subarray(1).toString('latin1');
        console.log(`PREPARE ${connectionId} ${JSON.stringify(sql)}`);
        record({ type: 'prepare', connectionId, sql });
      }
    }

    if (!target.write(chunk)) {
      client.pause();
    }
  });

  target.on('drain', () => client.resume());
  target.on('data', (chunk) => {
    targetBuffer = Buffer.concat([targetBuffer, chunk]);
    while (targetBuffer.length >= 4) {
      const payloadLength = targetBuffer.readUIntLE(0, 3);
      const packetLength = payloadLength + 4;
      if (targetBuffer.length < packetLength) break;

      const payload = targetBuffer.subarray(4, packetLength);
      targetBuffer = targetBuffer.subarray(packetLength);
      if (payload[0] === 0xff && payload.length >= 3) {
        const code = payload.readUInt16LE(1);
        const messageStart = payload[3] === 0x23 ? 9 : 3;
        const message = payload.subarray(messageStart).toString('latin1');
        console.error(`MYSQL_ERROR ${connectionId} ${code} ${message}`);
        record({ type: 'mysql-error', connectionId, code, message });
      }
    }

    if (!client.write(chunk)) {
      target.pause();
    }
  });
  client.on('drain', () => target.resume());

  const closeBoth = () => {
    client.destroy();
    target.destroy();
  };

  client.on('error', (error) => console.error(`CLIENT_ERROR ${connectionId} ${error.message}`));
  target.on('error', (error) => console.error(`TARGET_ERROR ${connectionId} ${error.message}`));
  client.on('close', closeBoth);
  target.on('close', closeBoth);
});

proxy.listen(listenPort, listenHost, () => {
  console.log(`READY ${listenHost}:${listenPort} -> ${targetHost}:${targetPort}`);
  console.log(`LOG ${logPath}`);
  record({ type: 'ready', listenHost, listenPort, targetHost, targetPort });
});

process.stdin.setEncoding('utf8');
process.stdin.on('data', (input) => {
  for (const line of input.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const label = line.startsWith('MARK ') ? line.slice(5) : line;
    console.log(`MARK ${label}`);
    record({ type: 'marker', label });
  }
});

const shutdown = () => proxy.close(() => {
  log.end(() => process.exit(0));
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
