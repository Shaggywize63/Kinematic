'use strict';

const zapier = require('zapier-platform-core');

const authentication = require('./authentication');
const createLead = require('./creates/lead');

module.exports = {
  // Pinned by the version of zapier-platform-core this app was built
  // against (see package.json). `zapier build`/`zapier push` re-derive
  // this from node_modules at build time; it's here for `zapier validate`
  // and for the test harness below to construct a real App instance.
  version: require('./package.json').version,
  platformVersion: zapier.version,

  authentication,

  beforeRequest: [],
  afterResponse: [],

  resources: {},
  triggers: {},
  searches: {},

  creates: {
    [createLead.key]: createLead,
  },
};
