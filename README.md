# KiwiBNC - An IRC bouncer

* Stay connected to IRC. For one person or 10,000 people
* Zero downtime updates and restarts. Don't knock everyone offline because an update is available
* Extensible via javascript plugins
* Use with older or modern IRCv3 clients
* Message storage via sqlite database

## Status
While KiwiBNC is already in use for single users and some networks it is currently in development and may break. If you require 100% uptime and rely on your BNC for your health, do not use it yet.

For general usage it is working and is currently being put to the test in live environments. However, as we learn more on how people use the project things may change at the moment.

## TODO
* Plain text file message logs
* Web admin interface
* Websocket support

## Installation

### Prerequisites
* nodejs
* npm

```shell
$ git clone https://github.com/kiwiirc/kiwibnc.git
$ cd kiwibnc
```

## Usage
```shell
$ npm start
```

## IRCv3 support

### KiwiBNC <> server spec support:
* server-time
* multi-prefix
* away-notify
* account-notify
* account-tag
* extended-join
* userhost-in-names

### Client <> KiwiBNC spec support:
* batch
* server-time
* away-notify
* account-notify
* account-tag
* extended-join
* multi-prefix
* userhost-in-names

## License
[Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.html)
