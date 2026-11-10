import test, { after } from 'node:test';
import assert from 'node:assert/strict';

// Keep integration tests isolated from the user's local SQLite database.
process.env.DATABASE_PATH = ':memory:';
const { app } = await import('../server/index.ts');

after(async () => {
  await app.close();
});

test('all API endpoints used during initial load respond successfully on a clean database', async () => {
  const checks = [
    ['/api/health', (body: any) => assert.equal(body.ok, true)],
    ['/api/dashboard', (body: any) => {
      assert.equal(body.servers, 0);
      assert.equal(body.offers, 0);
      assert.equal(body.dataReady, false);
    }],
    ['/api/servers', (body: any) => assert.deepEqual(body, [])],
    ['/api/opportunities?kind=all', (body: any) => {
      assert.equal(body.count, 0);
      assert.deepEqual(body.opportunities, []);
    }],
    ['/api/products', (body: any) => assert.deepEqual(body, [])],
    ['/api/events?limit=20', (body: any) => assert.deepEqual(body, [])],
    ['/api/history', (body: any) => assert.deepEqual(body, [])],
    ['/api/market/offers', (body: any) => assert.deepEqual(body, [])],
    ['/api/simulations', (body: any) => assert.deepEqual(body, [])],
    ['/api/settings/analysis', (body: any) => assert.equal(body.maxOperations, 6)],
  ] as const;

  for (const [url, verify] of checks) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200, `${url} returned ${response.statusCode}: ${response.body}`);
    verify(response.json());
  }
});

test('route search handles an empty local market', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/routes/search',
    payload: { currency: 'RELAX', capital: '150' },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().routes, []);
  assert.equal(response.json().analyzedOffers, 0);
});

test('server can be created and deleted through the API', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/servers',
    payload: {
      name: 'Integration test',
      gameServerUrl: '',
      goodPriceUrl: 'http://127.0.0.1:3001/plugin/GoodPrice',
    },
  });

  assert.equal(created.statusCode, 201, created.body);
  const { id } = created.json() as { id: string };
  assert.ok(id);

  const listed = await app.inject({ method: 'GET', url: '/api/servers' });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().length, 1);

  const removed = await app.inject({ method: 'DELETE', url: `/api/servers/${id}` });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(removed.json(), { ok: true });
});
