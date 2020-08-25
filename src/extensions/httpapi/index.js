/**
 * Adds a /httpapi endpoint to the webserver
 *
 * Clients know if it is available via a 'kiwibnc/httpapi' supports token.
 * Requests must include a "Authorization: Bearer token" header where the token is a user token
 *
 * Example requests:
 * /httpapi?command=sendmessage&networkid=1&target=%23channel&message=a+reply+to+your+message
 * /httpapi?command=logout
 */

module.exports.init = async function init(hooks, app) {
    hooks.on('available_isupports', async event => {
        event.tokens.push('kiwibnc/httpapi');
    });

    app.webserver.router.get('/httpapi', async ctx => {
        // Authorization: Bearer token1234
        let token = (ctx.headers['authorization'] || '').split(' ')[1]
        if (!token) {
            ctx.response.status = 401;
            return;
        }

        let user = await app.userDb.authUserToken(token, ctx.ip);
        if (!user) {
            ctx.response.status = 401;
            return;
        }

        let command = (ctx.query.command || '').replace(/[^a-z_]/ig, '');
        let args = Object.assign({}, ctx.query);
        delete args.command;

        if (!command || !apiCommands[command]) {
            ctx.body = {
                error: {
                    code: 'unknown_command',
                    message: 'This an unknown command',
                    command,
                },
            };
            return;
        }

        try {
            let result = await apiCommands[command](args, {
                user,
                hooks,
                app,
                token,
                webCtx: ctx,
            });
            ctx.body = {
                error: null,
                result: result || true,
            };
        } catch (err) {
            if (err instanceof CommandError) {
                // An error thrown from the command itself
                ctx.body = {
                    error: {
                        code: err.code,
                        message: err.message,
                    },
                };
                ctx.response.status = 500;
            } else {
                // An unexpected error
                l.error(`HTTPAPI error with command '${command}':`, err.stack);

                ctx.body = {
                    error: {
                        code: 'internal_error',
                        message: 'An error occured running the command',
                        command,
                    },
                };
                ctx.response.status = 500;
            }
        }
    });
};

class CommandError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
      this.name = 'CommandError';
    }
  }

const apiCommands = Object.create(null);
apiCommands.logout = async (args, {user, app, token, hooks}) => {
    await app.userDb.removeUserToken(user.id, token);
    await hooks.emit('httpapi_command_logout', { user, token, args })
    return { loggedout: true };
};

apiCommands.sendmessage = async (args, {user, app, token, hooks}) => {
    if (!args.networkid || !args.target || !args.message) {
        throw new CommandError('missing_args', 'A target and message must be provided');
    }

    let con = app.cons.findUsersOutgoingConnection(user.id, parseInt(args.networkid, 10));
    if (!con) {
        throw new CommandError('network_not_found', 'The network was not found or is not connected');
    }

    if (!con.state.netRegistered) {
        throw new CommandError('network_disconnected', 'The network is not connected');
    }

    con.writeLine('PRIVMSG', args.target, args.message);
    return { sent: true };
};
