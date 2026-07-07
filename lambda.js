const serverless = require('@vendia/serverless-express');
const { app } = require('./server');

// serverless-express returns a callback-style (event, context, callback) handler.
// Node.js 24's Lambda runtime rejects callback-based handlers at init, so wrap it
// in a 2-arg async handler (the underlying handler returns a promise when no
// callback is passed).
const proxy = serverless({ app });
exports.handler = async (event, context) => proxy(event, context);
