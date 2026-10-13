import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';
import vm from 'node:vm';

async function handler() {
  const source = await readFile(new URL('../whatsapp-service.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  async handleWebhook(');
  const end = source.indexOf('  async handle(req', start);
  const context = vm.createContext({ Buffer, createHmac, timingSafeEqual });
  const instance = vm.runInContext('new (class {' + source.slice(start, end) + '})()', context);
  instance.webhookSecret = 'test-secret';
  instance.json = (_res, status) => status;
  instance.dialogCache = {};
  return instance;
}

test('unsigned and malformed webhook signatures are rejected without reading a body', async () => {
  const service = await handler();
  for (const signature of ['', 'é'.repeat(64), 'x'.repeat(64)]) {
    const req = { headers: { 'x-wacli-signature': signature }, async *[Symbol.asyncIterator]() { throw Error('Body must not be read'); } };
    assert.equal(await service.handleWebhook(req, {}), 401);
  }
});

test('webhook bodies are bounded even with a plausible signature', async () => {
  const service = await handler();
  const req = { headers: { 'x-wacli-signature': 'a'.repeat(64) }, async *[Symbol.asyncIterator]() { yield Buffer.alloc(1_000_001); } };
  assert.equal(await service.handleWebhook(req, {}), 413);
});

test('valid signed webhook remains accepted', async () => {
  const service = await handler();
  const body = Buffer.from('{"EventType":"test"}');
  const signature = createHmac('sha256', 'test-secret').update(body).digest('hex');
  const req = { headers: { 'x-wacli-signature': signature }, async *[Symbol.asyncIterator]() { yield body; } };
  assert.equal(await service.handleWebhook(req, {}), 204);
});
