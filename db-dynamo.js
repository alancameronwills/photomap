const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, UpdateCommand, ScanCommand, QueryCommand, TransactWriteCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
const crypto = require('crypto');

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const POIS_TABLE   = process.env.POIS_TABLE   || 'PhotomapPois';
const PHOTOS_TABLE = process.env.PHOTOS_TABLE || 'PhotomapPhotos';
const ROUTES_TABLE = process.env.ROUTES_TABLE || 'PhotomapRoutes';
const NODES_TABLE  = process.env.NODES_TABLE  || 'PhotomapRouteNodes';

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function findNearestPoi(lat, lng, maxMeters) {
  const { Items = [] } = await docClient.send(new ScanCommand({
    TableName: POIS_TABLE,
    ProjectionExpression: 'id, lat, lng',
  }));
  let best = null, bestDist = maxMeters;
  for (const p of Items) {
    const d = haversineMeters(lat, lng, p.lat, p.lng);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

async function getAllPois() {
  const [{ Items: pois = [] }, { Items: photos = [] }] = await Promise.all([
    docClient.send(new ScanCommand({ TableName: POIS_TABLE })),
    docClient.send(new ScanCommand({ TableName: PHOTOS_TABLE })),
  ]);
  const photosByPoi = {};
  for (const ph of photos) {
    if (!photosByPoi[ph.poi_id]) photosByPoi[ph.poi_id] = [];
    photosByPoi[ph.poi_id].push(ph);
  }
  for (const id in photosByPoi) {
    photosByPoi[id].sort((a, b) => a.order_index - b.order_index || a.id.localeCompare(b.id));
  }
  pois.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return pois.map(p => ({ ...p, photos: photosByPoi[p.id] || [] }));
}

async function getPoiById(id) {
  const [{ Item: poi }, { Items: photos = [] }] = await Promise.all([
    docClient.send(new GetCommand({ TableName: POIS_TABLE, Key: { id } })),
    docClient.send(new QueryCommand({
      TableName: PHOTOS_TABLE,
      IndexName: 'poi_id-order_index-index',
      KeyConditionExpression: 'poi_id = :pid',
      ExpressionAttributeValues: { ':pid': id },
    })),
  ]);
  if (!poi) return null;
  photos.sort((a, b) => a.order_index - b.order_index || a.id.localeCompare(b.id));
  return { ...poi, photos };
}

async function createPoi(lat, lng, title, note) {
  const id = crypto.randomUUID();
  const ts = now();
  const item = { id, lat, lng, title: title || null, note: note || null, created_at: ts, updated_at: ts };
  await docClient.send(new PutCommand({ TableName: POIS_TABLE, Item: item }));
  return { ...item, photos: [] };
}

async function updatePoi(id, { lat, lng, title, note }) {
  const exprs = [], names = {}, vals = {};
  if (lat   !== undefined) { exprs.push('#lat = :lat');     names['#lat']   = 'lat';   vals[':lat']   = lat; }
  if (lng   !== undefined) { exprs.push('#lng = :lng');     names['#lng']   = 'lng';   vals[':lng']   = lng; }
  if (title !== undefined) { exprs.push('#title = :title'); names['#title'] = 'title'; vals[':title'] = title || null; }
  if (note  !== undefined) { exprs.push('#note = :note');   names['#note']  = 'note';  vals[':note']  = note || null; }
  if (!exprs.length) return getPoiById(id);
  exprs.push('updated_at = :ua');
  vals[':ua'] = now();
  await docClient.send(new UpdateCommand({
    TableName: POIS_TABLE,
    Key: { id },
    UpdateExpression: `SET ${exprs.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: vals,
  }));
  if (lat !== undefined || lng !== undefined) {
    const { Item } = await docClient.send(new GetCommand({ TableName: POIS_TABLE, Key: { id } }));
    if (Item) await syncPoiNodes(id, Item.lat, Item.lng);
  }
  return getPoiById(id);
}

async function deletePoi(id) {
  const { Items: photos = [] } = await docClient.send(new QueryCommand({
    TableName: PHOTOS_TABLE,
    IndexName: 'poi_id-order_index-index',
    KeyConditionExpression: 'poi_id = :pid',
    ExpressionAttributeValues: { ':pid': id },
    ProjectionExpression: 'id',
  }));
  await _batchDeleteItems(PHOTOS_TABLE, photos.map(p => p.id));
  await docClient.send(new DeleteCommand({ TableName: POIS_TABLE, Key: { id } }));
}

async function addPhoto(poiId, filename, thumbFilename, originalName, orderIndex) {
  const id = crypto.randomUUID();
  const item = {
    id, poi_id: poiId, filename, thumb_filename: thumbFilename,
    original_name: originalName, order_index: orderIndex || 0, created_at: now(),
  };
  await docClient.send(new PutCommand({ TableName: PHOTOS_TABLE, Item: item }));
  return item;
}

async function deletePhoto(id) {
  const { Item: photo } = await docClient.send(new GetCommand({ TableName: PHOTOS_TABLE, Key: { id } }));
  if (!photo) return null;
  await docClient.send(new DeleteCommand({ TableName: PHOTOS_TABLE, Key: { id } }));
  return photo;
}

async function reorderPhotos(poiId, orderedIds) {
  for (let i = 0; i < orderedIds.length; i += 25) {
    const chunk = orderedIds.slice(i, i + 25);
    await docClient.send(new TransactWriteCommand({
      TransactItems: chunk.map((photoId, j) => ({
        Update: {
          TableName: PHOTOS_TABLE,
          Key: { id: photoId },
          UpdateExpression: 'SET order_index = :oi',
          ConditionExpression: 'poi_id = :pid',
          ExpressionAttributeValues: { ':oi': i + j, ':pid': poiId },
        },
      })),
    }));
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

async function getAllRoutes() {
  const [{ Items: routes = [] }, { Items: nodes = [] }] = await Promise.all([
    docClient.send(new ScanCommand({ TableName: ROUTES_TABLE })),
    docClient.send(new ScanCommand({ TableName: NODES_TABLE })),
  ]);
  routes.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const byRoute = {};
  for (const n of nodes) {
    if (!byRoute[n.route_id]) byRoute[n.route_id] = [];
    byRoute[n.route_id].push(n);
  }
  for (const id in byRoute) {
    byRoute[id].sort((a, b) => a.order_index - b.order_index || a.id.localeCompare(b.id));
  }
  return routes.map(r => ({ ...r, nodes: byRoute[r.id] || [] }));
}

async function getRouteById(id) {
  const [{ Item: route }, { Items: nodes = [] }] = await Promise.all([
    docClient.send(new GetCommand({ TableName: ROUTES_TABLE, Key: { id } })),
    docClient.send(new QueryCommand({
      TableName: NODES_TABLE,
      IndexName: 'route_id-order_index-index',
      KeyConditionExpression: 'route_id = :rid',
      ExpressionAttributeValues: { ':rid': id },
    })),
  ]);
  if (!route) return null;
  nodes.sort((a, b) => a.order_index - b.order_index || a.id.localeCompare(b.id));
  return { ...route, nodes };
}

async function createRoute(name, color) {
  const id = crypto.randomUUID();
  const item = { id, name: name || null, color: color || '#ff69b4', created_at: now() };
  await docClient.send(new PutCommand({ TableName: ROUTES_TABLE, Item: item }));
  return { ...item, nodes: [] };
}

async function updateRoute(id, { name, color }) {
  const exprs = [], names = {}, vals = {};
  if (name  !== undefined) { exprs.push('#n = :n'); names['#n'] = 'name';  vals[':n'] = name  || null; }
  if (color !== undefined) { exprs.push('color = :c');                     vals[':c'] = color || '#ff69b4'; }
  if (!exprs.length) return getRouteById(id);
  await docClient.send(new UpdateCommand({
    TableName: ROUTES_TABLE,
    Key: { id },
    UpdateExpression: `SET ${exprs.join(', ')}`,
    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
    ExpressionAttributeValues: vals,
  }));
  return getRouteById(id);
}

async function deleteRoute(id) {
  const { Items: nodes = [] } = await docClient.send(new QueryCommand({
    TableName: NODES_TABLE,
    IndexName: 'route_id-order_index-index',
    KeyConditionExpression: 'route_id = :rid',
    ExpressionAttributeValues: { ':rid': id },
    ProjectionExpression: 'id',
  }));
  await _batchDeleteItems(NODES_TABLE, nodes.map(n => n.id));
  await docClient.send(new DeleteCommand({ TableName: ROUTES_TABLE, Key: { id } }));
}

async function splitRoute(routeId, splitNodeId) {
  const { Items: allNodes = [] } = await docClient.send(new QueryCommand({
    TableName: NODES_TABLE,
    IndexName: 'route_id-order_index-index',
    KeyConditionExpression: 'route_id = :rid',
    ExpressionAttributeValues: { ':rid': routeId },
    ScanIndexForward: true,
  }));
  allNodes.sort((a, b) => a.order_index - b.order_index);

  const splitIdx = allNodes.findIndex(n => n.id === splitNodeId);
  if (splitIdx < 0) return null;

  const headNodes = allNodes.slice(0, splitIdx);
  const tailNodes = allNodes.slice(splitIdx + 1);

  await docClient.send(new DeleteCommand({ TableName: NODES_TABLE, Key: { id: splitNodeId } }));

  let newRoute = null;
  const deletedTailNodeIds = [];

  if (tailNodes.length >= 2) {
    const { Item: origRoute } = await docClient.send(new GetCommand({ TableName: ROUTES_TABLE, Key: { id: routeId } }));
    const newRouteId = crypto.randomUUID();
    const newRouteItem = { id: newRouteId, name: null, color: origRoute?.color || '#ff69b4', created_at: now() };
    await docClient.send(new PutCommand({ TableName: ROUTES_TABLE, Item: newRouteItem }));

    for (let i = 0; i < tailNodes.length; i += 25) {
      const chunk = tailNodes.slice(i, i + 25);
      await docClient.send(new TransactWriteCommand({
        TransactItems: chunk.map(n => ({
          Update: {
            TableName: NODES_TABLE,
            Key: { id: n.id },
            UpdateExpression: 'SET route_id = :rid',
            ExpressionAttributeValues: { ':rid': newRouteId },
          },
        })),
      }));
    }
    newRoute = { ...newRouteItem, nodes: tailNodes.map(n => ({ ...n, route_id: newRouteId })) };
  } else {
    for (const n of tailNodes) {
      deletedTailNodeIds.push(n.id);
      await docClient.send(new DeleteCommand({ TableName: NODES_TABLE, Key: { id: n.id } }));
    }
  }

  let headDeleted = false;
  const deletedHeadNodeIds = headNodes.map(n => n.id);
  if (headNodes.length < 2) {
    await _batchDeleteItems(NODES_TABLE, headNodes.map(n => n.id));
    await docClient.send(new DeleteCommand({ TableName: ROUTES_TABLE, Key: { id: routeId } }));
    headDeleted = true;
  }

  return { splitNodeId, originalRouteId: routeId, headDeleted, deletedHeadNodeIds, deletedTailNodeIds, newRoute };
}

async function insertRouteNode(routeId, afterNodeId, lat, lng, poiId) {
  const { Item: after } = await docClient.send(new GetCommand({ TableName: NODES_TABLE, Key: { id: afterNodeId } }));
  if (!after) return null;
  const { Items: nextItems = [] } = await docClient.send(new QueryCommand({
    TableName: NODES_TABLE,
    IndexName: 'route_id-order_index-index',
    KeyConditionExpression: 'route_id = :rid AND order_index > :oi',
    ExpressionAttributeValues: { ':rid': routeId, ':oi': after.order_index },
    ScanIndexForward: true,
    Limit: 1,
  }));
  const next = nextItems[0];
  const orderIndex = next ? (after.order_index + next.order_index) / 2 : after.order_index + 1;
  const id = crypto.randomUUID();
  const item = { id, route_id: routeId, order_index: orderIndex, lat, lng, ...(poiId ? { poi_id: poiId } : {}) };
  await docClient.send(new PutCommand({ TableName: NODES_TABLE, Item: item }));
  return item;
}

async function addRouteNode(routeId, lat, lng, poiId, prepend = false) {
  const { Items: items = [] } = await docClient.send(new QueryCommand({
    TableName: NODES_TABLE,
    IndexName: 'route_id-order_index-index',
    KeyConditionExpression: 'route_id = :rid',
    ExpressionAttributeValues: { ':rid': routeId },
    ScanIndexForward: prepend,
    Limit: 1,
  }));
  const edge = items[0];
  const orderIndex = prepend
    ? (edge?.order_index ?? 0) - 1
    : (edge?.order_index ?? -1) + 1;
  const id = crypto.randomUUID();
  const item = { id, route_id: routeId, order_index: orderIndex, lat, lng, ...(poiId ? { poi_id: poiId } : {}) };
  await docClient.send(new PutCommand({ TableName: NODES_TABLE, Item: item }));
  return item;
}

async function updateRouteNode(id, { lat, lng, poiId }) {
  const exprs = [], names = {}, vals = {};
  const removes = [];
  if (lat   !== undefined) { exprs.push('#lat = :lat'); names['#lat'] = 'lat'; vals[':lat'] = lat; }
  if (lng   !== undefined) { exprs.push('#lng = :lng'); names['#lng'] = 'lng'; vals[':lng'] = lng; }
  if (poiId !== undefined) {
    if (poiId) { exprs.push('poi_id = :pid'); vals[':pid'] = poiId; }
    else removes.push('poi_id');
  }
  if (!exprs.length && !removes.length) {
    const { Item } = await docClient.send(new GetCommand({ TableName: NODES_TABLE, Key: { id } }));
    return Item || null;
  }
  const updateExpr = [
    exprs.length  ? `SET ${exprs.join(', ')}` : '',
    removes.length ? `REMOVE ${removes.join(', ')}` : '',
  ].filter(Boolean).join(' ');
  await docClient.send(new UpdateCommand({
    TableName: NODES_TABLE,
    Key: { id },
    UpdateExpression: updateExpr,
    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
    ...(Object.keys(vals).length  ? { ExpressionAttributeValues: vals }  : {}),
  }));
  const { Item } = await docClient.send(new GetCommand({ TableName: NODES_TABLE, Key: { id } }));
  return Item || null;
}

async function deleteRouteNode(id) {
  const { Item: node } = await docClient.send(new GetCommand({ TableName: NODES_TABLE, Key: { id } }));
  if (!node) return { deletedNodeIds: [], routeDeleted: false, routeId: null };

  const { Items: allNodes = [] } = await docClient.send(new QueryCommand({
    TableName: NODES_TABLE,
    IndexName: 'route_id-order_index-index',
    KeyConditionExpression: 'route_id = :rid',
    ExpressionAttributeValues: { ':rid': node.route_id },
    ProjectionExpression: 'id',
  }));
  const allIds = allNodes.map(n => n.id);

  await docClient.send(new DeleteCommand({ TableName: NODES_TABLE, Key: { id } }));

  if (allIds.length - 1 < 2) {
    const remainingIds = allIds.filter(nid => nid !== id);
    await _batchDeleteItems(NODES_TABLE, remainingIds);
    await docClient.send(new DeleteCommand({ TableName: ROUTES_TABLE, Key: { id: node.route_id } }));
    return { deletedNodeIds: allIds, routeDeleted: true, routeId: node.route_id };
  }
  return { deletedNodeIds: [id], routeDeleted: false, routeId: node.route_id };
}

async function deletePoiLinkedNodes(poiId) {
  const { Items: linked = [] } = await docClient.send(new QueryCommand({
    TableName: NODES_TABLE,
    IndexName: 'poi_id-index',
    KeyConditionExpression: 'poi_id = :pid',
    ExpressionAttributeValues: { ':pid': poiId },
  }));
  if (!linked.length) return { deletedNodeIds: [], deletedRouteIds: [] };

  const routeIds = [...new Set(linked.map(n => n.route_id))];
  const allByRoute = {};
  for (const rid of routeIds) {
    const { Items = [] } = await docClient.send(new QueryCommand({
      TableName: NODES_TABLE,
      IndexName: 'route_id-order_index-index',
      KeyConditionExpression: 'route_id = :rid',
      ExpressionAttributeValues: { ':rid': rid },
      ProjectionExpression: 'id',
    }));
    allByRoute[rid] = Items.map(n => n.id);
  }

  await _batchDeleteItems(NODES_TABLE, linked.map(n => n.id));

  const deletedNodeIds = new Set(linked.map(n => n.id));
  const deletedRouteIds = [];

  for (const rid of routeIds) {
    const linkedInRoute = linked.filter(n => n.route_id === rid).length;
    const remaining = allByRoute[rid].length - linkedInRoute;
    if (remaining < 2) {
      const remainingIds = allByRoute[rid].filter(nid => !deletedNodeIds.has(nid));
      await _batchDeleteItems(NODES_TABLE, remainingIds);
      await docClient.send(new DeleteCommand({ TableName: ROUTES_TABLE, Key: { id: rid } }));
      deletedRouteIds.push(rid);
      for (const nid of allByRoute[rid]) deletedNodeIds.add(nid);
    }
  }
  return { deletedNodeIds: [...deletedNodeIds], deletedRouteIds };
}

async function syncPoiNodes(poiId, lat, lng) {
  const { Items = [] } = await docClient.send(new QueryCommand({
    TableName: NODES_TABLE,
    IndexName: 'poi_id-index',
    KeyConditionExpression: 'poi_id = :pid',
    ExpressionAttributeValues: { ':pid': poiId },
    ProjectionExpression: 'id',
  }));
  for (let i = 0; i < Items.length; i += 25) {
    const chunk = Items.slice(i, i + 25);
    await docClient.send(new TransactWriteCommand({
      TransactItems: chunk.map(n => ({
        Update: {
          TableName: NODES_TABLE,
          Key: { id: n.id },
          UpdateExpression: 'SET #lat = :lat, #lng = :lng',
          ExpressionAttributeNames: { '#lat': 'lat', '#lng': 'lng' },
          ExpressionAttributeValues: { ':lat': lat, ':lng': lng },
        },
      })),
    }));
  }
}

async function _batchDeleteItems(tableName, ids) {
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    await docClient.send(new BatchWriteCommand({
      RequestItems: {
        [tableName]: chunk.map(id => ({ DeleteRequest: { Key: { id } } })),
      },
    }));
  }
}

module.exports = {
  haversineMeters,
  splitRoute,
  insertRouteNode,
  findNearestPoi,
  getAllPois,
  getPoiById,
  createPoi,
  updatePoi,
  deletePoi,
  addPhoto,
  deletePhoto,
  reorderPhotos,
  getAllRoutes,
  getRouteById,
  createRoute,
  updateRoute,
  deleteRoute,
  addRouteNode,
  updateRouteNode,
  deleteRouteNode,
  deletePoiLinkedNodes,
  syncPoiNodes,
};
