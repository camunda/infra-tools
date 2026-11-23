import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Registry } from '../lib/registry.mjs';
import { retryTransient } from '../lib/repository.mjs';

// An error of gh api, as execFileSync throws it.
const ghError = (stderr) => Object.assign(new Error(`Command failed: gh api\n${stderr}`), { stderr });

// A call failing with each error in turn, then answering.
function failing(...errors) {
  const calls = [];
  return { calls, call: () => (calls.push(1), errors.length ? (() => { throw errors.shift(); })() : 'answer') };
}

test('a transient gh api error is retried with backoff (ADR 0012)', () => {
  const slept = [];
  const { call, calls } = failing(ghError('gh: Server Error (HTTP 502)'), ghError('gh: You have exceeded a secondary rate limit (HTTP 403)'), ghError('Post "https://api.github.com/graphql": read tcp: connection reset by peer'));
  assert.equal(retryTransient(call, { delays: [1, 2, 3], sleep: (ms) => slept.push(ms) }), 'answer');
  assert.equal(calls.length, 4);
  assert.deepEqual(slept, [1, 2, 3]);
});

test('any other gh api error fails at once, and a transient one once its retries are spent', () => {
  const notFound = failing(ghError('gh: Not Found (HTTP 404)'));
  assert.throws(() => retryTransient(notFound.call, { delays: [1], sleep: () => {} }), { stderr: 'gh: Not Found (HTTP 404)' });
  assert.equal(notFound.calls.length, 1);
  const down = failing(ghError('gh: Service Unavailable (HTTP 503)'), ghError('gh: Service Unavailable (HTTP 503)'));
  assert.throws(() => retryTransient(down.call, { delays: [1], sleep: () => {} }), { stderr: 'gh: Service Unavailable (HTTP 503)' });
  assert.equal(down.calls.length, 2);
});

// A registry answering each request with the next status of its path's list, then 200.
async function flakyRegistry(statuses) {
  const seen = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    seen.push(path);
    const status = statuses[path]?.shift() ?? 200;
    if (status !== 200) return res.writeHead(status).end('busy');
    if (path === '/token') return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"token":"t"}');
    if (req.headers.authorization !== 'Bearer t') return res.writeHead(401, { 'www-authenticate': `Bearer realm="http://${req.headers.host}/token",service="x"` }).end();
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"tags":["node-26.1.0-r1"]}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { seen, host: `127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('a registry rate limit or server error is retried with backoff, token requests included (ADR 0012)', async () => {
  const fake = await flakyRegistry({ '/token': [503], '/v2/camunda/infra-tools/tags/list': [429, 502] });
  try {
    const registry = new Registry(`${fake.host}/camunda/infra-tools`, { token: 'x', scheme: 'http', retryDelays: [1, 1, 1] });
    assert.deepEqual(await registry.tags(), ['node-26.1.0-r1']);
  } finally {
    fake.close();
  }
});

test('a registry error that persists past the retries fails, never read as missing', async () => {
  const fake = await flakyRegistry({ '/v2/camunda/infra-tools/tags/list': [503, 503, 503] });
  try {
    const registry = new Registry(`${fake.host}/camunda/infra-tools`, { token: 'x', scheme: 'http', retryDelays: [1] });
    await assert.rejects(registry.tags(), /HTTP 503/);
  } finally {
    fake.close();
  }
});
