const serverless = require('@vendia/serverless-express');
const { app } = require('./server');

exports.handler = serverless({ app });
