import net from 'net';
import {Binder} from 'event-bind';
import {CancellationToken} from '@jil/common/cancellation';
import {Connback, ConnbackOpts, Connector} from '../../connback';
import {EchoTcpServer} from './server';
import * as ports from './ports';

export function givenEchoTcpServer() {
  return new EchoTcpServer();
}

export type ConnectOptions = ConnbackOpts &
  net.TcpSocketConnectOpts & {
    ping?: Connector<net.Socket>['ping'];
  };

class TcpConnector implements Connector<net.Socket> {
  constructor(public opts: ConnectOptions) {
    if (opts.ping) {
      this.ping = opts.ping;
    }
  }

  connect = (_: Connback<net.Socket>, token: CancellationToken) => {
    return new Promise<net.Socket>((resolve, reject) => {
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
      socket.connect(this.opts);
    });
  };

  close = (client: net.Socket) => client.end();

  ping = (client: net.Socket) => client.write('hello');
}

export function givenTcpConnback(
  portOrOpts: number | Partial<ConnectOptions> = ports.PORT,
  options?: Partial<ConnectOptions>,
) {
  const opts = <ConnectOptions>(typeof portOrOpts === 'number' ? {port: portOrOpts} : portOrOpts ?? options ?? {});
  opts.host = '127.0.0.1';
  opts.port = opts.port ?? ports.PORT;

  const connback = new Connback<net.Socket>(new TcpConnector(opts), opts);

  connback.onconnect(socket => {
    const binder = Binder.for(socket)
      .bind('error', (error: Error) => connback.feedError(error))
      .bind('data', () => connback.feedHeartbeat())
      .bind('close', (hasError?: boolean) => connback.feedClose(hasError))
      .bind('close', () => {
        binder.unbind();
      });
  });

  return connback;
}
