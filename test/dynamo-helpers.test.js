const { test } = require('node:test');
const assert = require('node:assert');
const { scanAll, batchWrite } = require('../dynamo-helpers');

const delReq = (id) => ({ DeleteRequest: { Key: { id } } });

// A fake DynamoDB document client: `send` inspects the command's `.input` and
// returns canned pages, so we can exercise the pagination loop without AWS.

test('scanAll follows LastEvaluatedKey across pages', async () => {
  const pages = [
    { Items: [{ id: 1 }, { id: 2 }], LastEvaluatedKey: { id: 2 } },
    { Items: [{ id: 3 }],            LastEvaluatedKey: { id: 3 } },
    { Items: [{ id: 4 }] }, // no LastEvaluatedKey -> last page
  ];
  const startKeys = [];
  const client = {
    send: async (cmd) => {
      startKeys.push(cmd.input.ExclusiveStartKey);
      return pages.shift();
    },
  };

  const items = await scanAll(client, { TableName: 'T' });

  assert.deepStrictEqual(items.map((i) => i.id), [1, 2, 3, 4]);
  // First page has no start key; each subsequent page carries the prior key.
  assert.deepStrictEqual(startKeys, [undefined, { id: 2 }, { id: 3 }]);
});

test('scanAll returns [] for an empty table', async () => {
  const client = { send: async () => ({ Items: [] }) };
  assert.deepStrictEqual(await scanAll(client, { TableName: 'T' }), []);
});

test('scanAll makes a single call when there is no continuation key', async () => {
  let calls = 0;
  const client = {
    send: async () => { calls++; return { Items: [{ id: 'a' }] }; },
  };
  const items = await scanAll(client, { TableName: 'T' });
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(items, [{ id: 'a' }]);
});

test('batchWrite retries UnprocessedItems then succeeds', async () => {
  const responses = [
    { UnprocessedItems: { T: [delReq(2)] } }, // item 2 bounced
    {},                                        // retry clears it
  ];
  const sentSizes = [];
  const client = {
    send: async (cmd) => { sentSizes.push(cmd.input.RequestItems.T.length); return responses.shift(); },
  };
  let slept = 0;
  await batchWrite(client, 'T', [1, 2, 3].map(delReq), { sleepFn: async () => { slept++; } });
  assert.deepStrictEqual(sentSizes, [3, 1]); // all 3, then just the bounced one
  assert.strictEqual(slept, 1);
});

test('batchWrite throws after exhausting retries', async () => {
  const client = { send: async () => ({ UnprocessedItems: { T: [delReq(1)] } }) };
  await assert.rejects(
    batchWrite(client, 'T', [delReq(1)], { maxRetries: 2, sleepFn: async () => {} }),
    /unprocessed after 2 retries/
  );
});

test('batchWrite splits requests into 25-item batches', async () => {
  const sizes = [];
  const client = { send: async (cmd) => { sizes.push(cmd.input.RequestItems.T.length); return {}; } };
  const reqs = Array.from({ length: 60 }, (_, i) => delReq(i));
  await batchWrite(client, 'T', reqs, { sleepFn: async () => {} });
  assert.deepStrictEqual(sizes, [25, 25, 10]);
});

test('batchWrite is a no-op for an empty request list', async () => {
  let calls = 0;
  const client = { send: async () => { calls++; return {}; } };
  await batchWrite(client, 'T', []);
  assert.strictEqual(calls, 0);
});
