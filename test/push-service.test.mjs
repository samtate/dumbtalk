import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function service() {
  const sent = [];
  const source = (await readFile(new URL('../push-service.mjs', import.meta.url), 'utf8'))
    .replace('import webpush from "web-push";', '').replace('export function', 'function');
  const context = vm.createContext({
    Buffer, process: { env: {} },
    webpush: { sendNotification: async (_subscription, body, options) => { sent.push({ body: JSON.parse(body), options }); } },
  });
  vm.runInContext(source, context);
  const push = context.createPushService({
    config: { pushSubscriptions: [{ deviceId: 'phone' }], pushVapid: { publicKey: 'public', privateKey: 'private' }, pushVapidSubject: 'https://example.com' },
    persist: async () => {}, log: () => {},
  });
  return { push, sent };
}

test('message bursts preserve all messages and independent conversations', async () => {
  const { push, sent } = await service();
  await Promise.all([
    push.notifyIncoming({ conversationId: 'signal:group:a', messageId: '1', sender: 'Alice', body: 'First' }),
    push.notifyIncoming({ conversationId: 'signal:group:b', messageId: '2', sender: 'Bob', body: 'Other chat' }),
    push.notifyIncoming({ conversationId: 'signal:group:a', messageId: '3', sender: 'Carol', body: 'Third' }),
  ]);
  assert.deepEqual(sent.map(x => x.body.messageId), ['1', '2', '3']);
  assert.ok(sent.every(x => x.body.event === 'new-message' && !x.options.topic));
});

test('test notification remains separate and requests one hour retention', async () => {
  const { push, sent } = await service();
  await push.sendNow({ test: true, deviceId: 'phone' });
  assert.equal(sent[0].body.event, 'test');
  assert.equal(sent[0].options.TTL, 3600);
});

test('Signal payload includes group sender, canonical chat id and photo after backend restart', async () => {
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function notificationForMessage');
  const end = source.indexOf('function formatDuration', start);
  const context = vm.createContext({
    conversationAliases: new Map(), conversationDetails: new Map(),
    getAccount: async () => 'self', rpc: async () => [{ id: 'a/b=', name: 'Friends' }], log: () => {},
  });
  vm.runInContext(source.slice(start, end), context);
  const payload = await context.notificationForMessage({
    conversationId: 'group:a/b=', id: 'message-1', timestamp: 123,
    sender: 'Alice', senderId: 'alice', text: 'Hello',
  });
  assert.equal(payload.conversationId, 'signal:group:a/b=');
  assert.equal(payload.sender, 'Alice');
  assert.equal(payload.title, 'Friends');
  assert.equal(payload.isGroup, true);
  assert.equal(payload.avatarPath, '/api/avatar/group/a%2Fb%3D');
});

 test('long Unicode previews fit the encrypted Web Push payload budget', async () => {
  const { push, sent } = await service();
  await push.notifyIncoming({ title: 'Group', body: '😀'.repeat(4000), sender: 'Alice' });
  assert.ok(Buffer.byteLength(JSON.stringify(sent[0].body)) < 3500);
  assert.ok(!sent[0].body.body.includes('�'));
});
