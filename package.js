Package.describe({
  summary: "MongoDB Oplog Driver that is efficient with running on an append-only collection",
  version: '1.1.9_1'
});

Package.onUse(function (api) {
  api.use('npm-mongo', 'server');
  api.use('mongo', 'server');

  api.use([
    'random',
    'ejson',
    'underscore',
    'tracker',
    'mongo-id',
    'check',
    'ecmascript',
    'ddp',
    'minimongo',
    'mongo'
  ], 'server');

  api.use('callback-hook', 'server');

  api.export("MongoAppendOnlyDriver");

  api.addFiles(['append_only_observe_driver.js'], 'server');
});

Package.onTest(function (api) {
});
