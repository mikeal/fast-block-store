import { promises as fs } from 'fs'
import varints from 'varint'
import { decode } from '@ipld/dag-cbor'
import { CID } from 'multiformats'

const load = async (filename) => {
  const fd = await fs.open(filename)
  const stat = await fd.stat()
  const read = async (pos, length) => {
    const b = Buffer.alloc(length)
    await fd.read(b, 0, length, pos)
    return b
  }
  const onClose = () => fd.close()

  return new CAR({ read, readLength: stat.size, onClose })
}

const cache = new Map()

const varint = {
  decode: data => {
    const code = varints.decode(data)
    return [code, varints.decode.bytes]
  },
  encode: int => {
    if (cache.has(int)) return cache.get(int)
    const buff = Uint8Array.from(varints.encode(int))
    cache.set(int, buff)
    return buff
  }
}

const all = async function * (car) {
  const parser = await car._parse()
  yield * parser
}

const parse = async function * (car) {
  const { read, readLength } = car

  let setHeader
  car._header = new Promise(resolve => {
    setHeader = resolve
  })

  let chunk = await read(0, 9) // 9 byte max varint size
  let [size, len] = varint.decode(chunk)
  chunk = await read(len, size)
  len += size

  const header = decode(chunk)
  setHeader(header)

  let targetLength = 42 // fits common sha2-256 cids + partSize

  while (len < readLength) {
    const start = len
    let chunk = await read(start, targetLength) // read 3 varints
    if (chunk.length === 0) break
    let l = 0
    const [partSize, l0] = varint.decode(chunk)
    l += l0
    let [cidVersion, l1] = varint.decode(chunk.subarray(l))
    l += l1
    if (cidVersion === 1) {
      // CID Codec
      const [, l2] = varint.decode(chunk.subarray(l))
      l += l2
      // Multihash - Hash ID
      const [, l3] = varint.decode(chunk.subarray(l))
      l += l3
    } else if (cidVersion === 18) {
      cidVersion = 0
    } else {
      throw new Error(`parser error ${cidVersion}:${partSize}:${l0}:${l1}:${chunk.length}`)
    }
    // Multihash - Hash Length
    const [hashLength, l4] = varint.decode(chunk.subarray(l))
    l += l4
    if ((hashLength + l) > targetLength) {
      targetLength = hashLength + l
      chunk = await read(start, targetLength)
    }
    const dataStart = start + l + hashLength
    const dataLength = partSize - ((l - l0) + hashLength)
    const cidBinary = chunk.subarray(l0, l + hashLength)
    const cid = CID.decode(cidBinary)

    const bytes = await read(dataStart, dataLength)
    const entry = { cid, start, partSize, bytes }
    yield entry

    len += (partSize + l0)
  }

  car.parsing = false
  car.parsed = true
}

class CAR {
  constructor ({ store, read, readLength, onClose }) {
    if (!read || !readLength) throw new Error('Missing required argument')
    this.read = read
    this.readLength = readLength
    this.store = store
    this.readLength = readLength
    this.onClose = onClose
  }

  get isReader () {
    return !!this.read
  }

  get isWriter () {
    return !!this.store
  }

  _parse () {
    this._parsing = true
    this._parsed = false
    return parse(this)
  }

  all () {
    return all(this)
  }

  close () {
    return this.onClose()
  }
}

export { CAR, load /*, create */ }
