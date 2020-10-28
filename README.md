# fast-block-store

This is a proof-of-concept block store for IPLD. It's designed to flush out some ideas we have for faster block storage.

The technique is relatively simple:

* Block value data is stored in a rolling append-only log.
* The log/offset/length of each block is stored in a sharded key-value store keyed by CID.
  * We just use the last 4 bytes (Uint32) of the hash digest for every CID and shard over
    multiple independent on-disc key-value stores.
  * The POC is sharding into 256 leveldb stores.
    * Parsing a CAR file of the Filecoin chain the initial write speed is ~1M block writes per minute (AWS ec2 instance writing to EBS).
    * Waiting overnight for the chain to finish loading in order to determine the write speed after 500M blocks
      are in the store.
