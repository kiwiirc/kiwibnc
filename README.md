# WARNING: its an in progress prototype. Experimental.

### A multi user IRC bouncer.

* Zero downtime updates and restarts
* Scalable to many users and connections via scaling to multi process and machines
* Multi client support
* Message logging to sqlite by default
* Multiple message storage backends for different database storage
* IRC BNC <> server spec support:
  * server-time
  * multi-prefix
  * away-notify
  * account-notify
  * account-tag
  * extended-join
  * userhost-in-names, 
* IRC client <> BNC spec support:
  * batch
  * server-time
  * away-notify
  * account-notify
  * account-tag
  * extended-join
  * multi-prefix
  * userhost-in-names
