var Heartbeat = require('./heartbeat')
var Subscriptions = require('./subscriptions')
var Progress = require('./progress')
var Search = require('./search')
var RecentFeeds = require('./recent-feeds')
var LiveBacklinks = require('./live-backlinks')
var pull = require('pull-stream')
var pCont = require('pull-cont/source')

var plugins = {
  likes: require('./likes'),
  backlinks: require('./backlinks'),
  profile: require('./profile'),
  publicFeed: require('./public-feed'),
  subscriptions2: require('./subscriptions2'),
  thread: require('./thread'),
  privateFeed: require('./private-feed'),
  mentionsFeed: require('./mentions-feed'),
  gatherings: require('./gatherings'),
  networkFeed: require('./network-feed'),
  channelFeed: require('./channel-feed'),
  participatingFeed: require('./participating-feed'),
  channels: require('./channels'),
  contacts: require('./contacts')
}

var ref = require('ssb-ref')

exports.name = 'patchwork'
exports.version = require('../package.json').version
exports.manifest = {
  subscriptions: 'source',
  linearSearch: 'source',
  privateSearch: 'source',

  progress: 'source',
  recentFeeds: 'source',
  heartbeat: 'source',

  getSubscriptions: 'async',

  liveBacklinks: {
    subscribe: 'sync',
    unsubscribe: 'sync',
    stream: 'source'
  },

  disconnect: 'async'
}

for (var key in plugins) {
  exports.manifest[key] = plugins[key].manifest
}

exports.init = function (ssb, config) {
  var progress = Progress(ssb, config)
  var subscriptions = Subscriptions(ssb, config)
  var search = Search(ssb, config)
  var recentFeeds = RecentFeeds(ssb, config)

  var patchwork = {
    heartbeat: Heartbeat(ssb, config),
    subscriptions: subscriptions.stream,
    progress: progress.stream,
    recentFeeds: recentFeeds.stream,
    linearSearch: search.linear,
    privateSearch: search.privateLinear,
    getSubscriptions: subscriptions.get,
    liveBacklinks: LiveBacklinks(ssb, config),

    disconnect: function (opts, cb) {
      if (ref.isFeed(opts)) opts = { key: opts }
      if (opts && (opts.key || opts.host)) {
        ssb.gossip.peers().find(peer => {
          if (peer.state === 'connected' && (peer.key === opts.key || peer.host === opts.host)) {
            ssb.gossip.disconnect(peer, cb)
            return true
          }
        })
      }
    }
  }

  for (var key in plugins) {
    patchwork[key] = plugins[key].init(ssb, config)
  }

  // CONNECTIONS
  // prioritize friends for pub connections and remove blocked pubs (on startup)
  patchwork.contacts.raw.get((err, graph) => {
    if (!err) {
      ssb.gossip.peers().forEach((peer) => {
        if (graph[ssb.id]) {
          var value = graph[ssb.id][peer.key]
          if (value === true) { // following pub
            ssb.gossip.add(peer, 'friends')
          } else if (value === false) { // blocked pub
            ssb.gossip.remove(peer.key)
          }
        }
      })
    }
  })

  // refuse connections from blocked peers
  ssb.auth.hook(function (fn, args) {
    var self = this
    patchwork.contacts.isBlocking({ source: ssb.id, dest: args[0] }, function (_, blocked) {
      if (blocked) {
        args[1](new Error('Client is blocked'))
      } else {
        fn.apply(self, args)
      }
    })
  })

  // REPLICATION
  // keep replicate up to date with replicateStream (replacement for ssb-friends)
  pull(
    patchwork.contacts.replicateStream({ live: true }),
    pull.drain(data => {
      for (var k in data) {
        ssb.replicate.request(k, data[k] === true)
      }
    })
  )

  // update ebt with latest block info
  pull(
    patchwork.contacts.raw.stream({ live: true }),
    pull.drain((data) => {
      if (!data) return
      for (var from in data) {
        for (var to in data[from]) {
          var value = data[from][to]
          ssb.ebt.block(from, to, value === false)
        }
      }
    })
  )

  // use blocks in legacy replication (adapted from ssb-friends for legacy compat)
  ssb.createHistoryStream.hook(function (fn, args) {
    var opts = args[0]
    var peer = this
    return pCont(cb => {
      // wait till the index has loaded.
      patchwork.contacts.raw.get((_, graph) => {
        if (graph && opts.id !== peer.id && graph[opts.id] && graph[opts.id][peer.id] === false) {
          cb(null, function (abort, cb) {
            // just give them the cold shoulder
          })
        } else {
          cb(null, pull(
            fn.apply(peer, args),
            // break off this feed if they suddenly block the recipient.
            pull.take(function (msg) {
              // handle when createHistoryStream is called with keys: true
              if (!msg.content && msg.value.content) msg = msg.value
              if (msg.content.type !== 'contact') return true
              return !(
                msg.content.blocking && msg.content.contact === peer.id
              )
            })
          ))
        }
      })
    })
  })

  return patchwork
}
