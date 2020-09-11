/*
This ParallelQueue supports parallel processing of many FIFO queues, grouped into blocks that are
processed serially.

This is needed as an IRC connection messages must be processed serially but multiple IRC connections
can be handled at the same time in parallel. All of this can then be interrupted by an internal BNC
message such as "reset all connections" or "restart the process and then continue".

When an item has been received from the queue `item.ack()` must be called to remove it from the
queue. Items can only be received from a queue in order - once the first item has been ack()'d.
Once all items in a queue have been ack()'d that queue is then removed from its block.

The below diagram shows the structure of a populated queue. It has 3 blocks, each with its own FIFO
queues (typically a single IRC connection message lines).

- queue.get() gets the first item from any of the queues in Block 1.
- Once all items have been received and .ack()'ed from a queue, the queue is then removed.
- Once all queues have been removed, the empty block is then removed.
- The next block, Block 2, then becomes Block 1 and the process starts again.

The diagram would be replicated with these calls:
- queue.add('Block 1', 'queue1', item)
- queue.add('Block 1', 'queue2', item)
- queue.add('Block 1', 'queue3', item)
- queue.add('Block 2', 'queue1', item)
- queue.add('Block 3', 'conn01', item)
- queue.add('Block 3', 'conn02', item)
- queue.add('Block 3', 'conn03', item)
 
+----------------------------------------+
| Block 1                                |
|   +--------+  +--------+  +--------+   |
|   | queue1 |  | queue2 |  | queue3 |   |
|   |        |  |        |  |        |   |
|   |        |  |        |  |        |   |
|   |        |  |        |  |        |   |
|   |        |  |        |  |        |   |
|   +--------+  +--------+  +--------+   |
+--------------------+-------------------+
                     |
                     v
+--------------------+-------------------+
| Block 2                                |
|               +--------+               |
|               | queue1 |               |
|               |        |               |
|               |        |               |
|               |        |               |
|               |        |               |
|               +--------+               |
+--------------------+-------------------+
                     |
                     v
+--------------------+-------------------+
| Block 3                                |
|   +--------+  +--------+  +--------+   |
|   | conn01 |  | conn02 |  | conn03 |   |
|   |        |  |        |  |        |   |
|   |        |  |        |  |        |   |
|   |        |  |        |  |        |   |
|   |        |  |        |  |        |   |
|   +--------+  +--------+  +--------+   |
+----------------------------------------+
*/

module.exports = class ParallelQueue {
    constructor() {
        this.blocks = [];
    }

    isEmpty() {
        return this.blocks.length === 0;
    }

    newBlock(type) {
        let block = {
            type,
            queues: Object.create(null),
        };
        this.blocks.push(block);
        return block;
    }

    currentBlock() {
        return this.blocks[0];
    }

    add(type, queueKey, item) {
        let block = this.blocks[this.blocks.length - 1];
        if (!block || block.type !== type) {
            block = this.newBlock(type);
        }

        block.queues[queueKey] = block.queues[queueKey] || { list: [], inProgress: false};
        block.queues[queueKey].list.push(item);
    }

    get() {
        let blocks = this.blocks;
        let block = this.currentBlock();
        if (!block) {
            return;
        }

        let queuesIds = Object.keys(block.queues);
        let queueId = queuesIds.find(key => {
            let queue = block.queues[key];
            if (!queue.inProgress) {
                return true;
            }
        });

        let queue = block.queues[queueId];
        if (!queue) {
            return;
        }

        let item = queue.list[0];
        queue.inProgress = true;
        return {
            item,
            ack() {
                queue.list.shift();
                queue.inProgress = false;
                if (queue.list.length === 0) {
                    delete block.queues[queueId];
                }

                if (Object.keys(block.queues).length === 0) {
                    // No more items in this block, remove it so the next
                    // block can be processed
                    blocks.shift();
                }
            }
        };
    }
}
