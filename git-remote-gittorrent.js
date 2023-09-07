#!/usr/bin/env node

import Chalk from 'chalk'
import DHT from 'bittorrent-dht'
import hat from 'hat'
import magnet from 'magnet-uri'
import prettyjson from 'prettyjson'
import { spawn } from 'child_process'
import Swarm from 'bittorrent-swarm'
import utGittorren from 'ut_gittorrent'
import WebTorrent from 'webtorrent'
import zeroFill from 'zero-fill'
import { getConfig } from './get-config.js'
import git from './git.js'

// BitTorrent client version string (used in peer ID).
// Generated from package.json major and minor version. For example:
//   '0.16.1' -> '0016'
//   '1.2.5' -> '0102'

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const pckgJSON = require('./package.json')
const VERSION = pckgJSON.version.match(/([0-9]+)/g).slice(0, 2).map(zeroFill(2)).join('')

function die (error) {
  console.error(error)
  process.exit(1)
}

// Gotta enable color manually because stdout isn't a tty.
const chalk = new Chalk.constructor({ enabled: true })

const [config, configDir] = await getConfig()

const dht = new DHT({
  bootstrap: config.dht.bootstrap
})

// After building a dictionary of references (sha's to branch names), responds
// to git's "list" and "fetch" commands.
function talkToGit (refs) {
  process.stdin.setEncoding('utf8')
  let didFetch = false
  process.stdin.on('readable', function () {
    const chunk = process.stdin.read()
    if (chunk === 'capabilities\n') {
      process.stdout.write('fetch\n\n')
    } else if (chunk === 'list\n') {
      Object.keys(refs).forEach(function (branch, i) {
        process.stdout.write(refs[branch] + ' ' + branch + '\n')
      })
      process.stdout.write('\n')
    } else if (chunk && chunk.search(/^fetch/) !== -1) {
      didFetch = true
      chunk.split(/\n/).forEach(function (line) {
        if (line === '') {
          return
        }
        // Format: "fetch sha branch"
        line = line.split(/\s/)
        getInfoHash(line[1], line[2])
      })
    } else if (chunk && chunk !== '' && chunk !== '\n') {
      console.warn('unhandled command: "' + chunk + '"')
    }
    if (chunk === '\n') {
      process.stdout.write('\n')
      if (!didFetch) {
        // If git already has all the refs it needs, we should exit now.
        process.exit()
      }
    }
  })
  process.stdout.on('error', function () {
    // stdout was closed
  })
}

let remotename = process.argv[2]
let url = process.argv[3]
const matches = url.match(/gittorrent:\/\/([a-f0-9]{40})\/(.*)/)
const refs = {} // Maps branch names to sha's.
if (matches) {
  const key = matches[1]
  const reponame = matches[2]
  if (remotename.search(/^gittorrent:\/\//) !== -1) {
    remotename = key
  }
  dht.on('ready', function () {
    const val = Buffer.from(key, 'hex')
    dht.get(val, function (err, res) {
      if (err) {
        return console.error(err)
      }
      const json = res.v.toString()
      const repos = JSON.parse(json)
      console.warn('\nMutable key ' + chalk.green(key) + ' returned:\n' +
                   prettyjson.render(repos, { keysColor: 'yellow', valuesColor: 'green' }) + '\n')
      talkToGit(repos.repositories[reponame])
    })
  })
} else {
  url = url.replace(/^gittorrent:/i, 'git:')
  const ls = git.ls(url, function (sha, branch) {
    refs[branch] = sha
  })
  ls.on('exit', function (err) {
    if (err) {
      die(err)
    }
    dht.on('ready', function () {
      talkToGit(refs)
    })
  })
}

const fetching = {} // Maps shas -> {got: <bool>, swarm, branches: [...]}
let todo = 0 // The number of sha's we have yet to fetch. We will not exit
// until this equals zero.
dht.on('peer', function (addr, hash, from) {
  const goal = fetching[hash]
  if (!goal.peer) {
    todo++
    goal.peer = true
  }
  goal.swarm.addPeer(addr)
})

function getInfoHash (sha, branch) {
  branch = branch.replace(/^refs\/(heads\/)?/, '')
  branch = branch.replace(/\/head$/, '')

  // We use console.warn (stderr) because git ignores our writes to stdout.
  console.warn('Okay, we want to get ' + chalk.yellow(branch) + ': ' +
               chalk.green(sha))

  if (sha in fetching) {
    fetching[sha].branches.push(branch)
    // Prevent starting a redundant lookup
    return
  }

  const info = { got: false, peer: false, swarm: null, branches: [branch] }
  fetching[sha] = info

  const magnetUri = 'magnet:?xt=urn:btih:' + sha
  const parsed = magnet(magnetUri)
  dht.lookup(parsed.infoHash)

  const peerId = Buffer.from('-WW' + VERSION + '-' + hat(48), 'utf8')
  info.swarm = new Swarm(parsed.infoHash, peerId)
  info.swarm.on('wire', function (wire, addr) {
    console.warn('\nAdding swarm peer: ' + chalk.green(addr) + ' for ' +
                 chalk.green(parsed.infoHash))
    wire.use(utGittorren())
    wire.ut_gittorrent.on('handshake', function () {
      wire.ut_gittorrent.ask(parsed.infoHash)
    })
    wire.ut_gittorrent.on('receivedTorrent', function (infoHash) {
      const client = new WebTorrent({
        dht: {
          bootstrap: config.dht.bootstrap
        },
        tracker: false
      })
      client.download(infoHash, function (torrent) {
        console.warn('Downloading ' + chalk.green(torrent.files[0].path) +
                     ' with infohash: ' + chalk.green(infoHash) + '\n')
        torrent.on('done', function (done) {
          console.warn('done downloading: ' + chalk.green(torrent.files[0].path))
          fetching[sha].got = true

          const stream = torrent.files[0].createReadStream()
          const unpack = spawn('git', ['index-pack', '--stdin', '-v', '--fix-thin'])
          stream.pipe(unpack.stdin)
          unpack.stderr.pipe(process.stderr)
          unpack.on('exit', function (code) {
            todo--
            if (todo <= 0) {
              // These writes are actually necessary for git to finish
              // checkout.
              process.stdout.write('\n\n')
              process.exit()
            }
          })
        })
      })
    })
  })
}
