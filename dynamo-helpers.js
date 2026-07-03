// Small, client-agnostic DynamoDB helpers. Kept separate from db-dynamo.js so
// they can be unit-tested with a fake client (no AWS credentials / network).

const { ScanCommand } = require('@aws-sdk/lib-dynamodb');

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

module.exports = { scanAll };
