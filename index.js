import leveldown from 'leveldown'
import { load } from './load-car.js'
import { readdirSync, statSync, openSync, read, write, close } from 'fs'
import path from 'path'
import mkdirp from 'mkdirp'
import { promisify } from 'util'
import { deepStrictEqual as same } from 'assert'

const closeFd = promisify(close)

const maxInt = 0xFFFFFFFF
const maxLogSize = 1024 * 1000

const readOffset = (fd, position, length) => {
  return new Promise((resolve, reject) => {
    const buffer = Buffer.allocUnsafe(length)
    read(fd, buffer, 0, length, position, (err) => {
      if (err) return reject(err)
      resolve(buffer)
    })
  })
}

const bucket = (cid, size=256) => {
  const rand = cid.bytes.slice(cid.bytes.byteLength - 4)
  const view = new DataView(rand.buffer)
  const num = view.getUint32(0)
  return Math.floor((num / maxInt) * size)
}

let writes = 0

class FastStore {
  constructor (directory) {
    this.logDir = path.join(directory, 'logs')
    this.levelDir = path.join(directory, 'level')
    mkdirp.sync(this.logDir)
    mkdirp.sync(this.levelDir)
    this.levels = new Map()
    this.logs = new Map()
    this.currentLog = this.initLog()
  }

  initLog () {
    const files = readdirSync(this.logDir)
    if (files.length === 0) {
      return this.createLog(0)
    } else {
      const ints = files.map(f => parseInt(f.slice(0, f.indexOf('.')))).sort()
      return this.getLog(ints[ints.length -1])
    }
  }

  _logFile (int) {
    return path.join(this.logDir, int.toString() + '.log')
  }

  _createLogStream (int) {
    const p = this._logFile(int)
    const fd = openSync(p, 'a+')
    return fd
  }

  async createLog (int) {
    if (this.logs.has(int)) return this.logs.get(int)
    const fd = this._createLogStream(int)
    this.logs.set(int, [int, fd, 0])
    return this.logs.get(int)
  }

  async getLog (int) {
    if (this.logs.has(int)) return this.logs.get(int)
    const fd = this._createLogStream(int)
    const stat = statSync(this._logFile(int))
    this.logs.set(int, [int, fd, stat.size])
    return this.logs.get(int)
  }

  async writeBytes (bytes) {
    const log = await this.currentLog
    const [, fd] = log
    return new Promise((resolve, reject) => {
      const start = log[2]
      log[2] += bytes.byteLength
      if (log[2] > maxLogSize) {
        this.currentLog = this.createLog(log[0] + 1)
      }
      write(fd, bytes, 0, bytes.byteLength, start, err => {
        if (err) return reject(err)
        resolve([log[0], start, bytes.byteLength])
      })
    })
  }

  async getLevel (int) {
    if (this.levels.has(int)) return this.levels.get(int)
    const promise = new Promise(async resolve => {
      const db = leveldown(path.join(this.levelDir, int.toString()))
      const open = promisify(db.open.bind(db))
      await open({ createIfMissing: true })
      this.levels.set(int, {
        put: promisify(db.put.bind(db)),
        close: promisify(db.close.bind(db)),
        get: promisify(db.get.bind(db))
      })
      resolve(this.levels.get(int))
    })
    this.levels.set(int, promise)
    return promise
  }

  async put ({ cid, bytes }) {
    if (await this.has(cid)) return
    const location = await this.writeBytes(bytes)
    const level = await this.getLevel(bucket(cid))
    await level.put(cid.toString(), JSON.stringify(location))
    writes += 1
    return true
  }

  async has (cid) {
    const level = await this.getLevel(bucket(cid))
    try {
      await level.get(cid.toString())
      return true
    } catch (e) {
      if (!e.message.includes('NotFound')) throw e
      return false
    }
  }

  async get (cid) {
    const level = await this.getLevel(bucket(cid))
    const string = await level.get(cid.toString())
    const [ log, offset, length ] = JSON.parse(string)
    const [, fd] = await this.getLog(log)
    const bytes = await readOffset(fd, offset, length)
    return bytes
  }

  async close () {
    const levs = [...this.levels.values()].map(l => l.close())
    const streams = [...this.logs.values()].map(([,fd]) => closeFd(fd))
    return Promise.all([...levs, ...streams])
  }
}

const limiter = limit => {
  const pending = new Set()
  const handler = promise => {
    promise.then(() => pending.delete(promise))
    pending.add(promise)
    if (pending.size > limit) {
      return Promise.race([...pending])
    }
  }
  handler.finish = () => Promise.all([...pending])
  return handler
}

const run = async () => {
  const car = await load(process.argv[2])
  const store = new FastStore('db')
  const interval = setInterval(() => {
    console.log(writes, 'writes in the last minute')
    writes = 0
  }, 1000 * 60)

  const limit = limiter(10 * 1000)

  for await (const { bytes, cid } of car.all()) {
    await limit(store.put({ bytes, cid }))
  }

  await limit.finish()

  /*
  for await (const { bytes, cid } of car.all()) {
    const _bytes = await store.get(cid)
    same(bytes, _bytes)
  }
  */

  await store.close()
  clearInterval(interval)
}

run()
