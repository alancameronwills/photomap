const { test } = require('node:test');
const assert = require('node:assert');
const { scanAll } = require('../dynamo-helpers');

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
