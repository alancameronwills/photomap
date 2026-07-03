const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, UpdateCommand, QueryCommand, TransactWriteCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
const crypto = require('crypto');
const { scanAll } = require('./dynamo-helpers');

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const POIS_TABLE     = process.env.POIS_TABLE     || 'PhotomapPois';
const PHOTOS_TABLE   = process.env.PHOTOS_TABLE   || 'PhotomapPhotos';
const ROUTES_TABLE   = process.env.ROUTES_TABLE   || 'PhotomapRoutes';
const NODES_TABLE    = process.env.NODES_TABLE    || 'PhotomapRouteNodes';
const PROJECTS_TABLE = process.env.PROJECTS_TABLE || 'PhotomapProjects';

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ── Projects ──────────────────────────────────────────────────────────────────
// A POI/route whose project_id is absent is treated as belonging to the default
// project (fixed id 'default'). This lets pre-existing items show under one named
// project with no backfill/migration.

const DEFAULT_PROJECT_ID = 'default';
let _defaultEnsured = false;

async function ensureDefaultProject() {
  if (_defaultEnsured) return DEFAULT_PROJECT_ID;
  try {
    await docClient.send(new PutCommand({
      TableName: PROJECTS_TABLE,
      Item: { id: DEFAULT_PROJECT_ID, name: 'Pembs C2C', owner: null, is_default: true, created_at: now() },
      ConditionExpression: 'attribute_not_exists(id)',
    }));
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
  }
  _defaultEnsured = true;
  return DEFAULT_PROJECT_ID;
}

function getDefaultProjectId() { return DEFAULT_PROJECT_ID; }

function resolveProject(projectId) {
  return (projectId != null && projectId !== '') ? projectId : DEFAULT_PROJECT_ID;
}

async function getAllProjects() {
  await ensureDefaultProject();
  const Items = await scanAll(docClient, { TableName: PROJECTS_TABLE });
  Items.sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0) || (a.name || '').localeCompare(b.name || ''));
  return Items;
}

async function createProject(name, owner) {
  const id = crypto.randomUUID();
  const item = { id, name: name || 'Untitled', owner: owner || null, is_default: false, created_at: now() };
  await docClient.send(new PutCommand({ TableName: PROJECTS_TABLE, Item: item }));
  return item;
}

async function renameProject(id, name) {
  await docClient.send(new UpdateCommand({
    TableName: PROJECTS_TABLE,
    Key: { id },
    UpdateExpression: 'SET #n = :n',
    ExpressionAttributeNames: { '#n': 'name' },
    ExpressionAttributeValues: { ':n': name || 'Untitled' },
  }));
  const { Item } = await docClient.send(new GetCommand({ TableName: PROJECTS_TABLE, Key: { id } }));
  return Item || null;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function findNearestPoi(lat, lng, maxMeters, projectId) {
  const pid = resolveProject(projectId);
  const Items = await scanAll(docClient, {
    TableName: POIS_TABLE,
    ProjectionExpression: 'id, lat, lng, project_id',
  });
  let best = null, bestDist = maxMeters;
  for (const p of Items.filter(p => (p.project_id || DEFAULT_PROJECT_ID) === pid)) {
    const d = haversineMeters(lat, lng, p.lat, p.lng);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

async function getAllPois(projectId) {
  const pid = resolveProject(projectId);
  const [poisAll, photos] = await Promise.all([
    scanAll(docClient, { TableName: POIS_TABLE }),
    scanAll(docClient, { TableName: PHOTOS_TABLE }),
  ]);
  const pois = poisAll.filter(p => (p.project_id || DEFAULT_PROJECT_ID) === pid);
  const poiIds = new Set(pois.map(p => p.id));
  const photosByPoi = {};
  for (const ph of photos) {
    if (!poiIds.has(ph.poi_id)) continue; // scope to this project via parent membership
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

async function createPoi(lat, lng, title, note, projectId) {
  const id = crypto.randomUUID();
  const ts = now();
  const item = { id, lat, lng, title: title || null, note: note || null, project_id: resolveProject(projectId), created_at: ts, updated_at: ts };
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
  const { Item: poi } = await docClient.send(new GetCommand({
    TableName: POIS_TABLE, Key: { id: poiId }, ProjectionExpression: 'project_id',
  }));
  const id = crypto.randomUUID();
  const item = {
    id, poi_id: poiId, filename, thumb_filename: thumbFilename,
    original_name: originalName, order_index: orderIndex || 0,
    project_id: (poi && poi.project_id) || DEFAULT_PROJECT_ID, created_at: now(),
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

async function updatePhoto(id, { caption, direction, markerX, markerY, markerRotation }) {
  const exprs = [], names = {}, vals = {};
  const removes = [];
  if (caption !== undefined) {
    names['#cap'] = 'caption';
    if (caption) { exprs.push('#cap = :cap'); vals[':cap'] = caption; }
    else removes.push('#cap');
  }
  if (direction !== undefined) {
    if (direction) { exprs.push('direction = :dir'); vals[':dir'] = direction; }
    else removes.push('direction');
  }
  if (markerX !== undefined) {
    if (markerX != null) { exprs.push('marker_x = :mx'); vals[':mx'] = markerX; }
    else removes.push('marker_x');
  }
  if (markerY !== undefined) {
    if (markerY != null) { exprs.push('marker_y = :my'); vals[':my'] = markerY; }
    else removes.push('marker_y');
  }
  if (markerRotation !== undefined) {
    if (markerRotation != null) { exprs.push('marker_rotation = :mr'); vals[':mr'] = markerRotation; }
    else removes.push('marker_rotation');
  }
  if (!exprs.length && !removes.length) {
    const { Item } = await docClient.send(new GetCommand({ TableName: PHOTOS_TABLE, Key: { id } }));
    return Item || null;
  }
  const updateExpr = [
    exprs.length  ? `SET ${exprs.join(', ')}`    : '',
    removes.length ? `REMOVE ${removes.join(', ')}` : '',
  ].filter(Boolean).join(' ');
  await docClient.send(new UpdateCommand({
    TableName: PHOTOS_TABLE,
    Key: { id },
    UpdateExpression: updateExpr,
    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
    ...(Object.keys(vals).length  ? { ExpressionAttributeValues: vals }  : {}),
  }));
  const { Item } = await docClient.send(new GetCommand({ TableName: PHOTOS_TABLE, Key: { id } }));
  return Item || null;
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

async function getAllRoutes(projectId) {
  const pid = resolveProject(projectId);
  const [routesAll, nodes] = await Promise.all([
    scanAll(docClient, { TableName: ROUTES_TABLE }),
    scanAll(docClient, { TableName: NODES_TABLE }),
  ]);
  const routes = routesAll.filter(r => (r.project_id || DEFAULT_PROJECT_ID) === pid);
  routes.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const routeIds = new Set(routes.map(r => r.id));
  const byRoute = {};
  for (const n of nodes) {
    if (!routeIds.has(n.route_id)) continue; // scope to this project via parent membership
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

async function createRoute(name, color, projectId) {
  const id = crypto.randomUUID();
  const item = { id, name: name || null, color: color || '#ff69b4', project_id: resolveProject(projectId), created_at: now() };
  await docClient.send(new PutCommand({ TableName: ROUTES_TABLE, Item: item }));
  return { ...item, nodes: [] };
}

async function updateRoute(id, { name, color, dir1Name, dir2Name }) {
  const exprs = [], names = {}, vals = {};
  if (name     !== undefined) { exprs.push('#n = :n');   names['#n'] = 'name';     vals[':n'] = name     || null; }
  if (color    !== undefined) { exprs.push('color = :c');                           vals[':c'] = color    || '#ff69b4'; }
  if (dir1Name !== undefined) { exprs.push('dir1_name = :d1');                      vals[':d1'] = dir1Name || null; }
  if (dir2Name !== undefined) { exprs.push('dir2_name = :d2');                      vals[':d2'] = dir2Name || null; }
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
    const newRouteItem = { id: newRouteId, name: null, color: origRoute?.color || '#ff69b4', project_id: origRoute?.project_id || DEFAULT_PROJECT_ID, created_at: now() };
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

// A node's project always matches its route's. Used when no sibling node is
// available to copy project_id from (e.g. the first node added to a route).
async function routeProjectId(routeId) {
  const { Item } = await docClient.send(new GetCommand({
    TableName: ROUTES_TABLE, Key: { id: routeId }, ProjectionExpression: 'project_id',
  }));
  return (Item && Item.project_id) || DEFAULT_PROJECT_ID;
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
  const project_id = after.project_id || await routeProjectId(routeId);
  const id = crypto.randomUUID();
  const item = { id, route_id: routeId, order_index: orderIndex, lat, lng, project_id, ...(poiId ? { poi_id: poiId } : {}) };
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
  const project_id = (edge && edge.project_id) || await routeProjectId(routeId);
  const id = crypto.randomUUID();
  const item = { id, route_id: routeId, order_index: orderIndex, lat, lng, project_id, ...(poiId ? { poi_id: poiId } : {}) };
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
  getAllProjects,
  getDefaultProjectId,
  createProject,
  renameProject,
  getAllPois,
  getPoiById,
  createPoi,
  updatePoi,
  deletePoi,
  addPhoto,
  deletePhoto,
  updatePhoto,
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
