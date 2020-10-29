# fast-block-store

Storing data by a hashed based key (content address) has some
unique properties that allow for highly performance storage
systems to be built.

* The only transaction guarantee you need is per-key. Most
  databases go through a tremendous amount of effort to
  maintain a consistent transactional state across **all**
  the keys in a database.
* The key already includes randomization, which means you
  already have a vector for sharding the data across many stores.
* The value data never changes and most use cases only require
  an append-only (no deletes) storage engine.

This project is a proof-of-concept block store.

Write pipeline:

* `Block` (`Key`/`Value` pair) write
  * Key is a byte value that must end in a hash digest of at least 4 bytes.
    * Note: we don't specific whether this is a CID, a multihash, or hash digest.
      This is left up to the consumer, since different use cases may have differing
      key requirements.
  * `Value` is bytes data that matches the hash used in the key
* `Value` data is written to a rolling append-only file log.
  * The `Index` of this value is [ `LogNumber`, `Position`, `Length` ]
* `Key`/`Index` is written to a sharded key-value store.
  * Any key-value store will work.
    We can run additional tests to find the ideal on-disc storage structure.
  * The number of shards is user configurable and can be any integer. Since we have
    randomization in the hash digest we can use it to shard over any number of individual
    key-value stores.
  * This means that any compaction or re-balancing that needs to happen in the key-value store
    is spread out over the shards and randomized and as long as you provide a sufficient number
    of shards for your workflow you're unlikely to have any of this impact your overall write speed.

Specific to this implementation:

* The log/offset/length of each block is stored in a sharded key-value store keyed by CID.
  * We just use the last 4 bytes (Uint32) of the hash digest for every CID and shard over
    multiple independent on-disc key-value stores. So the shard id is just `Floor( ( Uint32(DigestTail) / 0xFFFFFFFF ) * TotalShards )
  * This POC is sharding into 256 leveldb stores.
    * Parsing a CAR file of the Filecoin chain the initial write speed is ~1M block writes per minute (AWS ec2 instance writing to EBS).
    * Write speeds remained stable even after all the chain data had been loaded. In this test the speed
    of CAR file parsing was still playing a factor in overall performance so we haven't even saturated the
    store yet.
      * In order to load the CAR data faster writes were happening with a high degree of concurrency. Leveldb
      optimizes under this kind of load so serial writes to the store are likely much lower than this benchmark
      shows.
