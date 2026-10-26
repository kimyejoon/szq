'use strict';
// Programmatic API (stable surface is intentionally small).
module.exports = {
  createClassifier: require('./guard/classify').createClassifier,
  adapters: require('./adapters'),
  stateKey: require('./cache').stateKey,
  loadConfig: require('./config').loadConfig,
};
