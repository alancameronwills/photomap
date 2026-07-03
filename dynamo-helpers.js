// Small, client-agnostic DynamoDB helpers. Kept separate from db-dynamo.js so
// they can be unit-tested with a fake client (no AWS credentials / network).

const { ScanCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run a Scan to completion, following LastEvaluatedKey. A single ScanCommand
// returns at most 1 MB of items; without this loop, larger tables are silently
// truncated — POIs vanish, findNearestPoi misses neighbours, routes lose nodes.
async function scanAll(client, params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await client.send(new ScanCommand({ ...params, ExclusiveStartKey }));
    if (out.Items) items.push(...out.Items);
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// Write a list of BatchWrite requests ({ PutRequest } / { DeleteRequest }) in
// 25-item batches, retrying whatever DynamoDB hands back in UnprocessedItems
// (throttling / partial failure) with exponential backoff. BatchWrite returning
// 200 does NOT mean every item was written — ignoring UnprocessedItems silently
// drops deletes, orphaning rows. Throws if items remain after maxRetries.
async function batchWrite(
  client,
  tableName,
  requests,
  { maxRetries = 8, baseDelayMs = 50, sleepFn = sleep } = {}
) {
  for (let i = 0; i < requests.length; i += 25) {
    let batch = requests.slice(i, i + 25);
    for (let attempt = 0; batch.length; attempt++) {
      const out = await client.send(
        new BatchWriteCommand({ RequestItems: { [tableName]: batch } })
      );
      const unprocessed = (out.UnprocessedItems && out.UnprocessedItems[tableName]) || [];
      if (!unprocessed.length) break;
      if (attempt >= maxRetries) {
        throw new Error(
          `BatchWrite to ${tableName}: ${unprocessed.length} items unprocessed after ${maxRetries} retries`
        );
      }
      await sleepFn(baseDelayMs * 2 ** attempt);
      batch = unprocessed;
    }
  }
}

module.exports = { scanAll, batchWrite };
