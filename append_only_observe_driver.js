var Fiber = Npm.require('fibers');
var Future = Npm.require('fibers/future');

var PHASE = {
  QUERYING: "QUERYING",
  FETCHING: "FETCHING",
  STEADY: "STEADY"
};

// Exception thrown by _needToPollQuery which unrolls the stack up to the
// enclosing call to finishIfNeedToPollQuery.
var SwitchedToQuery = function () {};
var finishIfNeedToPollQuery = function (f) {
  return function () {
    try {
      f.apply(this, arguments);
    } catch (e) {
      if (!(e instanceof SwitchedToQuery))
        throw e;
    }
  };
};

var currentId = 0;

AppendOnlyObserveDriver = function (options) {
  var self = this;
  self._usesOplog = true;  // tests look at this

  self._id = currentId;
  currentId++;

  self._cursorDescription = options.cursorDescription;
  self._mongoHandle = options.mongoHandle;
  self._multiplexer = options.multiplexer;

  if (options.ordered) {
    throw Error("OplogObserveDriver only supports unordered observeChanges");
  }

  var sorter = options.sorter;
  // We don't support $near and other geo-queries so it's OK to initialize the
  // comparator only once in the constructor.
  var comparator = sorter && sorter.getComparator();

  self._stopped = false;
  self._stopHandles = [];

  self._registerPhaseChange(PHASE.QUERYING);

  var selector = self._cursorDescription.selector;
  self._matcher = options.matcher;
  var projection = self._cursorDescription.options.fields || {};
  self._projectionFn = LocalCollection._compileProjection(projection);
  // Projection function, result of combining important fields for selector and
  // existing fields projection
  self._sharedProjection = self._matcher.combineIntoProjection(projection);
  if (sorter)
    self._sharedProjection = sorter.combineIntoProjection(self._sharedProjection);
  self._sharedProjectionFn = LocalCollection._compileProjection(
    self._sharedProjection);

  self._needToFetch = new LocalCollection._IdMap;
  self._currentlyFetching = null;
  self._fetchGeneration = 0;

  self._requeryWhenDoneThisQuery = false;
  self._writesToCommitWhenWeReachSteady = [];

  // If the oplog handle tells us that it skipped some entries (because it got
  // behind, say), re-poll.
  self._stopHandles.push(self._mongoHandle._oplogHandle.onSkippedEntries(
    finishIfNeedToPollQuery(function () {
      self._needToPollQuery();
    })
  ));

  forEachTrigger(self._cursorDescription, function (trigger) {
    self._stopHandles.push(self._mongoHandle._oplogHandle.onOplogEntry(
      trigger, function (notification) {
        Meteor._noYieldsAllowed(finishIfNeedToPollQuery(function () {
          var op = notification.op;
          if (notification.dropCollection || notification.dropDatabase) {
            // Note: this call is not allowed to block on anything (especially
            // on waiting for oplog entries to catch up) because that will block
            // onOplogEntry!
            self._needToPollQuery();
          } else {
            // All other operators should be handled depending on phase
            if (self._phase === PHASE.QUERYING)
              self._handleOplogEntryQuerying(op);
            else
              self._handleOplogEntrySteadyOrFetching(op);
          }
        }));
      }
    ));
  });

  // XXX ordering w.r.t. everything else?
  self._stopHandles.push(listenAll(
    self._cursorDescription, function (notification) {
      // If we're not in a pre-fire write fence, we don't have to do anything.
      var fence = DDPServer._CurrentWriteFence.get();
      if (!fence || fence.fired)
        return;

      if (fence._oplogAppendOnlyDrivers) {
        fence._oplogAppendOnlyDrivers[self._id] = self;
        return;
      }

      fence._oplogAppendOnlyDrivers = {};
      fence._oplogAppendOnlyDrivers[self._id] = self;

      fence.onBeforeFire(function () {
        var drivers = fence._oplogAppendOnlyDrivers;
        delete fence._oplogAppendOnlyDrivers;

        // This fence cannot fire until we've caught up to "this point" in the
        // oplog, and all observers made it back to the steady state.
        self._mongoHandle._oplogHandle.waitUntilCaughtUp();

        _.each(drivers, function (driver) {
          if (driver._stopped)
            return;

          var write = fence.beginWrite();
          if (driver._phase === PHASE.STEADY) {
            // Make sure that all of the callbacks have made it through the
            // multiplexer and been delivered to ObserveHandles before committing
            // writes.
            driver._multiplexer.onFlush(function () {
              write.committed();
            });
          } else {
            driver._writesToCommitWhenWeReachSteady.push(write);
          }
        });
      });
    }
  ));

  // When Mongo fails over, we need to repoll the query, in case we processed an
  // oplog entry that got rolled back.
  self._stopHandles.push(self._mongoHandle._onFailover(finishIfNeedToPollQuery(
    function () {
      self._needToPollQuery();
    })));

  // Give _observeChanges a chance to add the new ObserveHandle to our
  // multiplexer, so that the added calls get streamed.
  Meteor.defer(finishIfNeedToPollQuery(function () {
    self._runInitialQuery();
  }));
};

_.extend(AppendOnlyObserveDriver.prototype, {
  _addPublished: function (id, doc) {
    var self = this;
    Meteor._noYieldsAllowed(function () {
      self._multiplexer.added(id, self._projectionFn(doc));
    });
  },
  _removePublished: function (id) {
    var self = this;
    throw new Error("Collection was assumed to be append-only to use the AppendOnlyObserveDriver. delete doc at " + self._cursorDescription.collectionName);
  },
  _handleDoc: function (id, newDoc) {
    var self = this;
    throw new Error("Collection was assumed to be append-only to use the AppendOnlyObserveDriver. change to a doc at " + self._cursorDescription.collectionName);
  },
  _fetchModifiedDocuments: function () {
    var self = this;
    Meteor._noYieldsAllowed(function () {
      self._registerPhaseChange(PHASE.FETCHING);
      // Defer, because nothing called from the oplog entry handler may yield,
      // but fetch() yields.
      Meteor.defer(finishIfNeedToPollQuery(function () {
        while (!self._stopped && !self._needToFetch.empty()) {
          if (self._phase === PHASE.QUERYING) {
            // While fetching, we decided to go into QUERYING mode, and then we
            // saw another oplog entry, so _needToFetch is not empty. But we
            // shouldn't fetch these documents until AFTER the query is done.
            break;
          }

          // Being in steady phase here would be surprising.
          if (self._phase !== PHASE.FETCHING)
            throw new Error("phase in fetchModifiedDocuments: " + self._phase);

          self._currentlyFetching = self._needToFetch;
          var thisGeneration = ++self._fetchGeneration;
          self._needToFetch = new LocalCollection._IdMap;
          var waiting = 0;
          var fut = new Future;
          // This loop is safe, because _currentlyFetching will not be updated
          // during this loop (in fact, it is never mutated).
          self._currentlyFetching.forEach(function (cacheKey, id) {
            waiting++;
            self._mongoHandle._docFetcher.fetch(
              self._cursorDescription.collectionName, id, cacheKey,
              finishIfNeedToPollQuery(function (err, doc) {
                try {
                  if (err) {
                    Meteor._debug("Got exception while fetching documents: " +
                                  err);
                    // If we get an error from the fetcher (eg, trouble
                    // connecting to Mongo), let's just abandon the fetch phase
                    // altogether and fall back to polling. It's not like we're
                    // getting live updates anyway.
                    if (self._phase !== PHASE.QUERYING) {
                      self._needToPollQuery();
                    }
                  } else if (!self._stopped && self._phase === PHASE.FETCHING
                             && self._fetchGeneration === thisGeneration) {
                    // We re-check the generation in case we've had an explicit
                    // _pollQuery call (eg, in another fiber) which should
                    // effectively cancel this round of fetches.  (_pollQuery
                    // increments the generation.)
                    self._handleDoc(id, doc);
                  }
                } finally {
                  waiting--;
                  // Because fetch() never calls its callback synchronously,
                  // this is safe (ie, we won't call fut.return() before the
                  // forEach is done).
                  if (waiting === 0)
                    fut.return();
                }
              }));
          });
          fut.wait();
          // Exit now if we've had a _pollQuery call (here or in another fiber).
          if (self._phase === PHASE.QUERYING)
            return;
          self._currentlyFetching = null;
        }
        // We're done fetching, so we can be steady, unless we've had a
        // _pollQuery call (here or in another fiber).
        if (self._phase !== PHASE.QUERYING)
          self._beSteady();
      }));
    });
  },
  _beSteady: function () {
    var self = this;
    Meteor._noYieldsAllowed(function () {
      self._registerPhaseChange(PHASE.STEADY);
      var writes = self._writesToCommitWhenWeReachSteady;
      self._writesToCommitWhenWeReachSteady = [];
      self._multiplexer.onFlush(function () {
        _.each(writes, function (w) {
          w.committed();
        });
      });
    });
  },
  _handleOplogEntryQuerying: function (op) {
    var self = this;
    Meteor._noYieldsAllowed(function () {
      self._needToFetch.set(idForOp(op), op.ts.toString());
    });
  },
  _handleOplogEntrySteadyOrFetching: function (op) {
    var self = this;
    Meteor._noYieldsAllowed(function () {
      var id = idForOp(op);
      // If we're already fetching this one, or about to, we can't optimize;
      // make sure that we fetch it again if necessary.
      if (self._phase === PHASE.FETCHING &&
          ((self._currentlyFetching && self._currentlyFetching.has(id)) ||
           self._needToFetch.has(id))) {
        self._needToFetch.set(id, op.ts.toString());
        return;
      }

      if (op.op === 'd') {
        if (self._published.has(id) ||
            (self._limit && self._unpublishedBuffer.has(id)))
          self._removeMatching(id);
      } else if (op.op === 'i') {
        if (self._published.has(id))
          throw new Error("insert found for already-existing ID in published");
        if (self._unpublishedBuffer && self._unpublishedBuffer.has(id))
          throw new Error("insert found for already-existing ID in buffer");

        // XXX what if selector yields?  for now it can't but later it could
        // have $where
        if (self._matcher.documentMatches(op.o).result)
          self._addMatching(op.o);
      } else if (op.op === 'u') {
        // Is this a modifier ($set/$unset, which may require us to poll the
        // database to figure out if the whole document matches the selector) or
        // a replacement (in which case we can just directly re-evaluate the
        // selector)?
        var isReplace = !_.has(op.o, '$set') && !_.has(op.o, '$unset');

        if (isReplace) {
          self._handleDoc(id, _.extend({_id: id}, op.o));
        } else {
          // there is not much intelligent work we need to do, since _handleDoc is going to reject the operator anyway
          self._handleDoc(id, op.o);
        }
      }
    });
  },
  // Yields!
  _runInitialQuery: function () {
    var self = this;
    if (self._stopped)
      throw new Error("oplog stopped surprisingly early");

    self._runQuery({initial: true});  // yields

    if (self._stopped)
      return;  // can happen on queryError

    // Allow observeChanges calls to return. (After this, it's possible for
    // stop() to be called.)
    self._multiplexer.ready();

    self._doneQuerying();  // yields
  },

  // In various circumstances, we may just want to stop processing the oplog and
  // re-run the initial query, just as if we were a PollingObserveDriver.
  //
  // This function may not block, because it is called from an oplog entry
  // handler.
  //
  // XXX We should call this when we detect that we've been in FETCHING for "too
  // long".
  //
  // XXX We should call this when we detect Mongo failover (since that might
  // mean that some of the oplog entries we have processed have been rolled
  // back). The Node Mongo driver is in the middle of a bunch of huge
  // refactorings, including the way that it notifies you when primary
  // changes. Will put off implementing this until driver 1.4 is out.
  _pollQuery: function () {
    var self = this;
    Meteor._noYieldsAllowed(function () {
      if (self._stopped)
        return;

      // Yay, we get to forget about all the things we thought we had to fetch.
      self._needToFetch = new LocalCollection._IdMap;
      self._currentlyFetching = null;
      ++self._fetchGeneration;  // ignore any in-flight fetches
      self._registerPhaseChange(PHASE.QUERYING);

      // Defer so that we don't yield.  We don't need finishIfNeedToPollQuery
      // here because SwitchedToQuery is not thrown in QUERYING mode.
      Meteor.defer(function () {
        self._runQuery();
        self._doneQuerying();
      });
    });
  },

  // Yields!
  _runQuery: function (options) {
    var self = this;
    options = options || {};
    var newResults, newBuffer;

    // This while loop is just to retry failures.
    while (true) {
      // If we've been stopped, we don't have to run anything any more.
      if (self._stopped)
        return;

      newResults = [];

      var cursor = self._cursorForQuery({ limit: self._limit });
      try {
        cursor.forEach(function (doc, i) {  // yields
          newResults.push(doc);
        });
        break;
      } catch (e) {
        if (options.initial && typeof(e.code) === 'number') {
          // This is an error document sent to us by mongod, not a connection
          // error generated by the client. And we've never seen this query work
          // successfully. Probably it's a bad selector or something, so we
          // should NOT retry. Instead, we should halt the observe (which ends
          // up calling `stop` on us).
          self._multiplexer.queryError(e);
          return;
        }

        // During failover (eg) if we get an exception we should log and retry
        // instead of crashing.
        Meteor._debug("Got exception while polling query: " + e);
        Meteor._sleepForMs(100);
      }
    }

    if (self._stopped)
      return;

    self._publishNewResults(newResults);
  },

  // Transitions to QUERYING and runs another query, or (if already in QUERYING)
  // ensures that we will query again later.
  //
  // This function may not block, because it is called from an oplog entry
  // handler. However, if we were not already in the QUERYING phase, it throws
  // an exception that is caught by the closest surrounding
  // finishIfNeedToPollQuery call; this ensures that we don't continue running
  // close that was designed for another phase inside PHASE.QUERYING.
  //
  // (It's also necessary whenever logic in this file yields to check that other
  // phases haven't put us into QUERYING mode, though; eg,
  // _fetchModifiedDocuments does this.)
  _needToPollQuery: function () {
    var self = this;
    Meteor._noYieldsAllowed(function () {
      if (self._stopped)
        return;

      // If we're not already in the middle of a query, we can query now
      // (possibly pausing FETCHING).
      if (self._phase !== PHASE.QUERYING) {
        self._pollQuery();
        throw new SwitchedToQuery;
      }

      // We're currently in QUERYING. Set a flag to ensure that we run another
      // query when we're done.
      self._requeryWhenDoneThisQuery = true;
    });
  },

  // Yields!
  _doneQuerying: function () {
    var self = this;

    if (self._stopped)
      return;
    self._mongoHandle._oplogHandle.waitUntilCaughtUp();  // yields
    if (self._stopped)
      return;
    if (self._phase !== PHASE.QUERYING)
      throw Error("Phase unexpectedly " + self._phase);

    Meteor._noYieldsAllowed(function () {
      if (self._requeryWhenDoneThisQuery) {
        self._requeryWhenDoneThisQuery = false;
        self._pollQuery();
      } else if (self._needToFetch.empty()) {
        self._beSteady();
      } else {
        self._fetchModifiedDocuments();
      }
    });
  },

  _cursorForQuery: function (optionsOverwrite) {
    var self = this;
    return Meteor._noYieldsAllowed(function () {
      // The query we run is almost the same as the cursor we are observing,
      // with a few changes. We need to read all the fields that are relevant to
      // the selector, not just the fields we are going to publish (that's the
      // "shared" projection). And we don't want to apply any transform in the
      // cursor, because observeChanges shouldn't use the transform.
      var options = _.clone(self._cursorDescription.options);

      // Allow the caller to modify the options. Useful to specify different
      // skip and limit values.
      _.extend(options, optionsOverwrite);

      options.fields = self._sharedProjection;
      delete options.transform;
      // We are NOT deep cloning fields or selector here, which should be OK.
      var description = new CursorDescription(
        self._cursorDescription.collectionName,
        self._cursorDescription.selector,
        options);
      return new Cursor(self._mongoHandle, description);
    });
  },

  _publishNewResults: function (results) {
    var self = this;
    Meteor._noYieldsAllowed(function () {
      results.forEach(function (doc) {
        self._addPublished(doc._id, doc);
      });
    });
  },

  // This stop function is invoked from the onStop of the ObserveMultiplexer, so
  // it shouldn't actually be possible to call it until the multiplexer is
  // ready.
  //
  // It's important to check self._stopped after every call in this file that
  // can yield!
  stop: function () {
    var self = this;
    if (self._stopped)
      return;
    self._stopped = true;
    _.each(self._stopHandles, function (handle) {
      handle.stop();
    });

    // Note: we *don't* use multiplexer.onFlush here because this stop
    // callback is actually invoked by the multiplexer itself when it has
    // determined that there are no handles left. So nothing is actually going
    // to get flushed (and it's probably not valid to call methods on the
    // dying multiplexer).
    _.each(self._writesToCommitWhenWeReachSteady, function (w) {
      w.committed();  // maybe yields?
    });
    self._writesToCommitWhenWeReachSteady = null;

    // Proactively drop references to potentially big things.
    self._needToFetch = null;
    self._currentlyFetching = null;
    self._oplogEntryHandle = null;
    self._listenersHandle = null;
  },

  _registerPhaseChange: function (phase) {
    var self = this;
    Meteor._noYieldsAllowed(function () {
      var now = new Date;

      self._phase = phase;
      self._phaseStartTime = now;
    });
  }
});

// Does our oplog tailing code support this cursor? For now, we are being very
// conservative and allowing only simple queries with simple options.
// (This is a "static method".)
AppendOnlyObserveDriver.cursorSupported = function (cursorDescription, matcher) {
  // First, check the options.
  var options = cursorDescription.options;

  // Did the user say no explicitly?
  // underscored version of the option is COMPAT with 1.2
  if (options.disableOplog || options._disableOplog)
    return false;

  // No skip or limit support
  if (options.skip || options.limit) return false;

  // If a fields projection option is given check if it is supported by
  // minimongo (some operators are not supported).
  if (options.fields) {
    try {
      LocalCollection._checkSupportedProjection(options.fields);
    } catch (e) {
      if (e.name === "MinimongoError")
        return false;
      else
        throw e;
    }
  }

  // We don't allow the following selectors:
  //   - $where (not confident that we provide the same JS environment
  //             as Mongo, and can yield!)
  //   - $near (has "interesting" properties in MongoDB, like the possibility
  //            of returning an ID multiple times, though even polling maybe
  //            have a bug there)
  //           XXX: once we support it, we would need to think more on how we
  //           initialize the comparators when we create the driver.
  return !matcher.hasWhere() && !matcher.hasGeoQuery();
};

var CursorProto = MongoInternals.Connection.prototype.find().constructor.prototype;
CursorProto.appendOnlyPublishableCursor = function () {
  var self = this;
  return {
    _publishCursor: function (sub) {
      var collection = self._cursorDescription.collectionName;
      var observeHandle = cursor.observeChanges({
        added: function (id, fields) {
          sub.added(collection, id, fields);
        }
      });

      sub.onStop(function () {observeHandle.stop();});
      return observeHandle;
    }
  };
};

CursorProto.observeAppends = function (callbacks) {
  if (typeof callbacks === 'function') {
    callbacks = { added: callbacks };
  }

  var self = this;

  var cursorDescription = self._cursorDescription;

  // You may not filter out _id when observing changes, because the id is a core
  // part of the observeChanges API.
  if (cursorDescription.options.fields &&
      (cursorDescription.options.fields._id === 0 ||
       cursorDescription.options.fields._id === false)) {
    throw Error("You may not observe a cursor with {fields: {_id: 0}}");
  }

  var observeKey = JSON.stringify(
    _.extend({ordered: false}, cursorDescription, {appendOnly: true}));

  var multiplexer, observeDriver;
  var firstHandle = false;

  // Find a matching ObserveMultiplexer, or create a new one. This next block is
  // guaranteed to not yield (and it doesn't call anything that can observe a
  // new query), so no other calls to this function can interleave with it.
  Meteor._noYieldsAllowed(function () {
    if (_.has(self._mongo._observeMultiplexers, observeKey)) {
      multiplexer = self._mongo._observeMultiplexers[observeKey];
    } else {
      firstHandle = true;
      // Create a new ObserveMultiplexer.
      multiplexer = new ObserveMultiplexer({
        ordered: false,
        onStop: function () {
          delete self._mongo._observeMultiplexers[observeKey];
          observeDriver.stop();
        }
      });
      self._mongo._observeMultiplexers[observeKey] = multiplexer;
    }
  });

  var observeHandle = new ObserveHandle(multiplexer, callbacks);

  if (firstHandle) {
    var matcher, sorter;
    var canUseOplog = _.all([
      function () {
        // At a bare minimum, using the oplog requires us to have an oplog, to
        // want unordered callbacks, and to not want a callback on the polls
        // that won't happen.
        return self._mongo._oplogHandle &&
          !callbacks._testOnlyPollCallback;
      }, function () {
        // We need to be able to compile the selector. Fall back to polling for
        // some newfangled $selector that minimongo doesn't support yet.
        try {
          matcher = new Minimongo.Matcher(cursorDescription.selector);
          return true;
        } catch (e) {
          // XXX make all compilation errors MinimongoError or something
          //     so that this doesn't ignore unrelated exceptions
          return false;
        }
      }, function () {
        // ... and the selector itself needs to support oplog.
        return OplogObserveDriver.cursorSupported(cursorDescription, matcher);
      }, function () {
        // And we need to be able to compile the sort, if any.  eg, can't be
        // {$natural: 1}.
        if (!cursorDescription.options.sort)
          return true;
        try {
          sorter = new Minimongo.Sorter(cursorDescription.options.sort,
                                        { matcher: matcher });
          return true;
        } catch (e) {
          // XXX make all compilation errors MinimongoError or something
          //     so that this doesn't ignore unrelated exceptions
          return false;
        }
      }], function (f) { return f(); });  // invoke each function

    if (! canUseOplog) {
      throw new Error('Can not use oplog (either oplog is not available or the cursor is not supported)');
    }

    observeDriver = new AppendOnlyObserveDriver({
      cursorDescription: cursorDescription,
      mongoHandle: self._mongo,
      multiplexer: multiplexer,
      matcher: matcher,  // ignored by polling
      sorter: sorter  // ignored by polling
    });

    // This field is only set for use in tests.
    multiplexer._observeDriver = observeDriver;
  }

  // Blocks until the initial adds have been sent.
  multiplexer.addHandleAndSendInitialAdds(observeHandle);

  return observeHandle;
};
