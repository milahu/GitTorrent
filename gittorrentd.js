#!/usr/bin/env node

import DHT from 'bittorrent-dht'
import elliptic from 'elliptic'
import { glob } from 'glob'
import fs from 'fs'
import hat from 'hat'
import net from 'net'
import Protocol from 'bittorrent-protocol'
import utGittorrent from 'ut_gittorrent'
import utMetadata from 'ut_metadata'
import WebTorrent from 'webtorrent'
import zeroFill from 'zero-fill'
import git from './git.js'
import { getConfig } from './get-config.js'
import path from 'path'

// BitTorrent client version string (used in peer ID).
// Generated from package.json major and minor version. For example:
//   '0.16.1' -> '0016'
//   '1.2.5' -> '0102'
//
import { createRequire } from 'module'
const { ec: EC } = elliptic

const ed25519 = new EC('ed25519')
const require = createRequire(import.meta.url)
const pckgJSON = require('./package.json')
const VERSION = pckgJSON.version.match(/([0-9]+)/g).slice(0, 2).map(zeroFill(2)).join('')

function die (error) {
  console.error(error)
  process.exit(1)
}

const [config, configDir] = await getConfig()

const dht = new DHT({
  bootstrap: config.dht.bootstrap
})
dht.listen(config.dht.listen)

const announcedRefs = {
}
const userProfile = {
  repositories: {}
}

const keyPath = path.join(configDir, config.key)

console.log('loading keyfile: ' + keyPath)

const key = createOrReadKeyFile()

function createOrReadKeyFile () {
  if (!fs.existsSync(keyPath)) {
    const keypair = new EC('ed25519').genKeyPair()
    fs.writeFileSync(keyPath, JSON.stringify({
      pub: keypair.getPublic('hex'),
      priv: keypair.getPrivate('hex')
    }))
    // fix: key file has mode 0o051
    fs.chmodSync(keyPath, 0o600)
  }

  // Okay, now the file exists, whether created here or not.
  const key = JSON.parse(fs.readFileSync(keyPath).toString())
  return ed25519.keyPair({
    priv: key.priv,
    privEnc: 'hex',
    pub: key.pub,
    pubEnc: 'hex'
  })
}

function bpad (n, buf) {
  if (buf.length === n) return buf
  if (buf.length < n) {
    const b = Buffer.alloc(n)
    buf.copy(b, n - buf.length)
    for (let i = 0; i < n - buf.length; i++) b[i] = 0
    return b
  }
}

let head = ''

dht.on('ready', function () {
  // Spider all */.git dirs and announce all refs.
  const repos = glob.sync('*/{,.git/}git-daemon-export-ok', { strict: false })
  let count = repos.length
  repos.forEach(function (repo) {
    console.log('in repo ' + repo)
    repo = repo.replace(/git-daemon-export-ok$/, '')
    console.log(repo)

    const reponame = repo.replace(/\/.git\/$/, '')
    userProfile.repositories[reponame] = {}

    const ls = git.ls(repo, function (sha, ref) {
      // FIXME: Can't pull in too many branches, so only do heads for now.
      if (ref !== 'HEAD' && !ref.match(/^refs\/heads\//)) {
        return
      }
      if (ref === 'refs/heads/master') {
        head = sha
      }
      userProfile.repositories[reponame][ref] = sha
      if (!announcedRefs[sha]) {
        console.log('Announcing ' + sha + ' for ' + ref + ' on repo ' + repo)
        announcedRefs[sha] = repo
        dht.announce(sha, config.dht.announce, function (err) {
          if (err !== null) {
            console.log('Announced ' + sha)
          }
        })
      }
    })
    ls.stdout.on('end', function () {
      count--
      if (count <= 0) {
        publishMutableKey()
      }
    })
    ls.on('exit', function (err) {
      if (err) {
        die(err)
      }
    })
  })

  function publishMutableKey () {
    const json = JSON.stringify(userProfile)
    if (json.length > 950) {
      console.error("Can't publish mutable key: doesn't fit in 950 bytes.")
      return false
    }
    const value = Buffer.alloc(json.length)
    value.write(json)
    const sig = key.sign(value)
    const opts = {
      k: bpad(32, Buffer.from(key.getPublic().x.toArray())),
      seq: 0,
      v: value,
      sig: Buffer.concat([
        bpad(32, Buffer.from(sig.r.toArray())),
        bpad(32, Buffer.from(sig.s.toArray()))
      ])
    }
    console.log(json)
    dht.put(opts, function (errors, hash) {
      console.error('errors=', errors)
      console.log('hash=', hash.toString('hex'))
    })
  }

  net.createServer(function (socket) {
    const wire = new Protocol()
    wire.use(utGittorrent())
    wire.use(utMetadata())
    socket.pipe(wire).pipe(socket)
    wire.on('handshake', function (infoHash, peerId) {
      console.log('Received handshake for ' + infoHash.toString('hex'))
      const myPeerId = Buffer.from('-WW' + VERSION + '-' + hat(48), 'utf8')
      wire.handshake(Buffer.from(infoHash), Buffer.from(myPeerId))
    })
    wire.ut_gittorrent.on('generatePack', function (sha) {
      console.error('calling git pack-objects for ' + sha)
      if (!announcedRefs[sha]) {
        console.error('Asked for an unknown sha: ' + sha)
        return
      }
      const directory = announcedRefs[sha]
      let have = null
      if (sha !== head) {
        have = head
      }
      const pack = git.uploadPack(directory, sha, have)
      pack.stderr.pipe(process.stderr)
      pack.on('ready', function () {
        const filename = sha + '.pack'
        const stream = fs.createWriteStream(filename)
        pack.stdout.pipe(stream)
        stream.on('close', function () {
          console.error('Finished writing ' + filename)
          const webtorrent = new WebTorrent({
            dht: { bootstrap: config.dht.bootstrap },
            tracker: false
          })
          webtorrent.seed(filename, function onTorrent (torrent) {
            console.error(torrent.infoHash)
            wire.ut_gittorrent.sendTorrent(torrent.infoHash)
          })
        })
      })
      pack.on('exit', function (code) {
        if (code !== 0) {
          console.error('git-upload-pack process exited with code ' + code)
        }
      })
    })
  }).listen(config.dht.announce)
})
