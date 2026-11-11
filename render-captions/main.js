import {createHmac, randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import WebSocket, {WebSocketServer} from 'ws';

const candyOrigin = 'https://candy-ailab.github.io';
const voicePath = '/aipaas/voice/v1/realtimeAsrMultiZk/asr';
const gateways = ['openapi.teleagi.cn', 'api-maas.teleai.com.cn', 'openapi.teleagi.cn']
  .map(host => 'wss://' + host + voicePath);

function hmacHex(key, value) {
  return createHmac('sha256', key).update(value).digest('hex');
}

function authHeaders({appId, appKey, apiKey}, requestId) {
  const headers = {'Content-Type': 'application/json', 'Device-Uuid': requestId};
  if (appId) headers['X-APP-ID'] = appId;
  if (appId && appKey) {
    const timestamp = Math.floor(Date.now() / 1000);
    const prefix = 'teleai-cloud-auth-v1/' + appId + '/QG/' + timestamp + '/180';
    const signingKey = hmacHex(appKey, prefix);
    const signature = hmacHex(signingKey, 'GET\n' + voicePath + '\n\nx-app-id:' + appId);
    headers.Authorization = prefix + '/x-app-id/' + signature;
  } else {
    headers.Authorization = 'Bearer ' + apiKey;
  }
  return headers;
}

function closeSocket(socket, code = 1000) {
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close(code);
}

function connectGateway(url, headers, requestId, signal, onResult) {
  return new Promise((resolve, reject) => {
    const upstream = new WebSocket(url, {headers, handshakeTimeout: 4000, maxPayload: 128 * 1024});
    // Keep an error listener attached while a failed or cancelled handshake closes.
    upstream.on('error', () => {});
    function cleanUp() {
      clearTimeout(deadline);
      signal.removeEventListener('abort', fail);
      upstream.removeEventListener('message', onMessage);
      upstream.removeEventListener('close', fail);
      upstream.removeEventListener('error', fail);
    }
    function fail() {
      cleanUp();
      closeSocket(upstream);
      reject(new Error('天翼 AI 实时连接未就绪'));
    }
    function onMessage({data}) {
      let result;
      try {
        result = JSON.parse(data);
      } catch {
        fail();
        return;
      }
      if (result.code == null && result.message === 'success') return;
      if (![10000, 20003].includes(Number(result.code))) {
        console.warn('TeleAI rejected caption session', new URL(url).hostname, Number(result.code) || 'unknown');
        fail();
        return;
      }
      if (Number(result.res_status) !== 0) return;
      cleanUp();
      upstream.addEventListener('message', onResult);
      resolve(upstream);
    }
    const deadline = setTimeout(fail, 4000);
    signal.addEventListener('abort', fail, {once: true});
    upstream.addEventListener('message', onMessage);
    upstream.addEventListener('close', fail);
    upstream.addEventListener('error', fail);
    upstream.addEventListener('open', () => {
      upstream.send(JSON.stringify({
        req_id: requestId, rec_status: 0,
        option: {format: 'pcm', sample_rate: 16000, enable_punctuation: true},
      }));
    }, {once: true});
    if (signal.aborted) fail();
  });
}

function relayCaptions(client, credentials, providerUrls) {
  const controller = new AbortController();
  let upstream;
  let ending = false;
  let startedAt = 0;
  let audioMs = 0;

  function send(message) {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  }

  function close(code = 1000) {
    clearTimeout(limit);
    controller.abort();
    closeSocket(client, code);
    closeSocket(upstream);
  }

  function unavailable() {
    if (controller.signal.aborted) return;
    send({type: 'error', message: '天翼 AI 实时字幕暂不可用'});
    close(1011);
  }

  function onResult({data}) {
    try {
      const result = JSON.parse(data);
      if (![10000, 20003].includes(Number(result.code))) {
        unavailable();
        return;
      }
      const status = Number(result.res_status);
      if ([2, 3, 4].includes(status)) {
        const text = result.data?.results?.[0]?.text;
        if (typeof text === 'string' && text) {
          send({type: 'caption', text, sequence: result.data?.sn, status, final: status !== 2});
        }
      }
      if (status === 4) close();
    } catch {
      unavailable();
    }
  }

  const limit = setTimeout(close, 3600_000);
  client.addEventListener('close', () => close());
  client.addEventListener('error', () => close(1011));
  client.addEventListener('message', ({data}) => {
    if (upstream?.readyState !== WebSocket.OPEN || ending) return;
    if (data === 'stop') {
      ending = true;
      upstream.send(JSON.stringify({rec_status: 2}));
      return;
    }
    if (!(data instanceof ArrayBuffer) || ![1600, 3200, 6400].includes(data.byteLength)) {
      close(1008);
      return;
    }
    audioMs += data.byteLength / 32;
    if (audioMs > Date.now() - startedAt + 2000) {
      close(1008);
      return;
    }
    upstream.send(JSON.stringify({
      rec_status: 1,
      audio_stream: Buffer.from(data).toString('base64'),
    }));
  });
  async function connect() {
    try {
      const requestId = randomUUID();
      const headers = authHeaders(credentials, requestId);
      for (const url of providerUrls) {
        if (controller.signal.aborted) return;
        try {
          upstream = await connectGateway(url, headers, requestId, controller.signal, onResult);
          break;
        } catch {
          if (!controller.signal.aborted) console.warn('TeleAI gateway unavailable', new URL(url).hostname);
        }
      }
      if (controller.signal.aborted) {
        closeSocket(upstream);
        return;
      }
      if (!upstream) {
        unavailable();
        return;
      }
      upstream.addEventListener('close', () => unavailable(), {once: true});
      upstream.addEventListener('error', () => unavailable(), {once: true});
      startedAt = Date.now();
      send({type: 'ready'});
    } catch {
      unavailable();
    }
  }

  void connect();
}

export function createCaptionServer(credentials, providerUrls = gateways) {
  const configured = Boolean((credentials.appId && credentials.appKey) || credentials.apiKey);
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(configured ? 200 : 503, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': candyOrigin,
      });
      response.end(JSON.stringify({configured}));
      return;
    }
    response.writeHead(request.url === '/api/live-demo' ? 426 : 404).end();
  });
  const sockets = new WebSocketServer({noServer: true, maxPayload: 6400});

  server.on('upgrade', (request, connection, head) => {
    if (request.method !== 'GET' || request.url !== '/api/live-demo') {
      connection.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if (request.headers.origin !== candyOrigin) {
      connection.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!configured) {
      connection.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, connection, head, client => {
      client.binaryType = 'arraybuffer';
      relayCaptions(client, credentials, providerUrls);
    });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createCaptionServer({
    appId: process.env.TELEAI_APP_ID,
    appKey: process.env.TELEAI_APP_KEY,
    apiKey: process.env.TELEAI_API_KEY,
  });
  const port = Number(process.env.PORT || 10000);
  server.listen(port, '0.0.0.0', () => console.log('Caption service listening on port ' + port));
}
