module.exports = process.env.POIS_TABLE
  ? require('./db-dynamo')
  : require('./db-sqlite');
