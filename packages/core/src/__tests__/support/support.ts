import net from 'net';
import {Binder} from 'event-bind';
import {Connector, ConnectorOpts, PingFn} from '../../connector';
import {EchoTcpServer} from './server';
import * as ports from './ports';

export function givenEchoTcpServer() {
  return new EchoTcpServer();
}

export type ConnectOptions = ConnectorOpts &
  net.TcpSocketConnectOpts & {
    ping: PingFn<net.Socket>;
  };

export function givenSocketConnector(
  portOrOpts: number | Partial<ConnectOptions> = ports.PORT,
  options?: Partial<ConnectOptions>,
) {
  const opts = <ConnectOptions>(typeof portOrOpts === 'number' ? {port: portOrOpts} : portOrOpts ?? options ?? {});
  opts.host = '127.0.0.1';
  opts.port = opts.port ?? ports.PORT;

  const connector = new Connector<net.Socket>(
    {
      connect: (c, token) => {
        return new Promise((resolve, reject) => {
          const socket = new net.Socket();
          token.onCancellationRequested(() => socket.end());
          const binder = Binder.for(socket)
            .bind('connect', () => {
              binder.unbind();
              resolve(socket);
            })
            .bind('error', (e: Error) => {
              binder.unbind();
              reject(e);
            });
          socket.connect(opts);
        });
      },
      close: socket => socket.end(),
      ping:
        opts.ping ??
        (socket => {
          socket.write('hello');
        }),
    },
    opts,
  );

  connector.onconnect(socket => {
    const binder = Binder.for(socket)
      .bind('error', (error: Error) => connector.feedError(error))
      .bind('data', () => connector.feedHeartbeat())
      .bind('close', (hasError?: boolean) => connector.feedClose(hasError))
      .bind('close', () => {
        binder.unbind();
      });
  });

  return connector;
}
