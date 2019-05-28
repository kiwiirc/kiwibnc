### Speedtest
Performes a benchmark of reading and writing messages between the socket and worker processes.

This shows how many IRC messages each second your system can handle.

~~~
$ node src/tools/testspeed.js
Benchmarking messages sent and received per second...
Run 1/10 5366/s
Run 2/10 4952/s
Run 3/10 6716/s
Run 4/10 6894/s
Run 5/10 5619/s
Run 6/10 5526/s
Run 7/10 5509/s
Run 8/10 5803/s
Run 9/10 5461/s
Run 10/10 4690/s
Average 5653 messages each second
Complete.
~~~

### Recover test
Tests that the worker process can be safely killed and restarted without loosing messages
from the socket process.

Run recover.js in the background, then start recover_worker.js. recover_worker.js will read
the messages sent from the sockets process and record its value.
When recover_worker.js is started and a previous value has been recorded, it will check
that the next value read is as expected. Kill the recover_worker.js process at will
to be sure it continues reading the expected message back on startup.

~~~
$ node src/tools/recover.js
~~~

~~~
$ node src/tools/recover_worker.js
Found correct value of 239
~~~
