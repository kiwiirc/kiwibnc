# KiwiBNC - An IRC bouncer

* Stay connected to IRC. For one person or 10,000 people
* Zero downtime updates and restarts. Don't knock everyone offline because an update is available
* Extensible via javascript plugins
* Use with older or modern IRCv3 clients
* Message storage via sqlite database
* RabbitMQ support for larger deployments

## Status
While KiwiBNC is already in use for single users and some networks it is currently in development and may break. If you require 100% uptime and rely on your BNC for your health, do not use it yet.

For general usage it is working and is currently being put to the test in live environments. However, as we learn more on how people use the project things may change at the moment.

## TODO
* Single binary downloads
* Plain text file message logs
* Web admin interface
* Websocket support

## Installation

### Prerequisites
Make sure to have installed on your system:
* nodejs
* npm

### Download and install
```shell
$ git clone https://github.com/kiwiirc/kiwibnc.git
$ cd kiwibnc
$ npm install
```

## Usage
After installing, take a glance over `config.ini` and make sure it suits your needs. It should work out of the box for most people.

#### Add a user
```shell
$ npm start adduser

> statebnc@1.0.0 start /home/kiwibnc
> node src/server.js "adduser"

01:09:17 [adduser] l_info ## Starting adduser ##
01:09:17 [adduser] l_info Using config file ./config.ini
Username: someuser
Password: ****
Admin account? n
Added new user someuser
```

#### Starting the bouncer
```shell
$ npm start
```

#### Adding networks and controlling your bouncer
Connect to your bouncer via your IRC client. Your password should be in the form of `username:password`. Once connected you will receive a private message from `*bnc` - this is your bouncer control buffer.

```
01:12 -!- Irssi: Starting query in localhost with *bnc
01:12 <*bnc> Welcome to your BNC!
01:12 <someuser> addnetwork
01:12 <*bnc> Usage: addnetwork name=example server=irc.example.net port=6697 tls=yes nick=mynick
01:12 <*bnc> Available fields: name, server, port, tls, nick, username, realname, password
01:12 <someuser> addnetwork name=freenode server=irc.freenode.net port=6667 nick=somenick
01:12 <*bnc> New network saved. You can now login using your_username/freenode:your_password
```

Send `help` to `*bnc` for all the commands you can send.


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
