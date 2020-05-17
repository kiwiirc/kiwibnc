# KiwiBNC - A modern IRC bouncer

* Stay connected to IRC. For one person or 10,000 people
* Zero downtime updates and restarts. Don't knock everyone offline because an update is available
* Extensible via javascript plugins
* Pick your own client. Older or modern IRCv3 clients
* Websocket support for direct web clients
* Built in web client
* Web admin interface
* Message storage via sqlite database or plain text files
* RabbitMQ support for larger deployments

## Status
While KiwiBNC is already in use for single users and some networks it is currently in development and may break. If you require 100% uptime and rely on your BNC for your health, do not use it yet.

For general usage it is working and is currently being put to the test in live environments. However, as we learn more on how people use the project things may change at the moment.

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
Running KiwiBNC for the first time will auto generate a config file in your home directory. You can also create your own using [this](https://github.com/kiwiirc/kiwibnc/blob/master/src/configProfileTemplate/config.ini) as a template and passing `--config=/path/to/config.ini` when running.

#### Add a user
```shell
$ node kiwibnc adduser
01:09:17 [adduser] l_info Starting adduser
01:09:17 [adduser] l_info Using config file /home/prawnsalad/.kiwibnc/config.ini
Username: someuser
Password: ****
Admin account? n
Added new user someuser
```

#### Starting the bouncer
```shell
$ node kiwibnc
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

IRCv3 capable IRC servers and clients are both supported. For a full capabilities list, see https://ircv3.net/software/clients#bouncers

## License
[Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.html)
