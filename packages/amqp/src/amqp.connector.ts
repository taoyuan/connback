import {SocketConnectOpts} from 'net';
import * as amqp from 'amqplib';
import {Binder} from 'event-bind';
import {ValueOrPromise} from '@jil/common';
import {CancellationToken} from '@jil/common/cancellation';
import {Event} from '@jil/common/event';
import {Connback, Connector} from '@connback/core';
import {AmqpConnection, AmqpConnectOpts} from './types';

export class AmqpConnector implements Connector<AmqpConnection> {
  constructor(public url: string | AmqpConnectOpts, public socketOptions?: SocketConnectOpts) {}

  connect = async (connback: Connback<AmqpConnection>, token: CancellationToken): Promise<AmqpConnection> => {
    const connection = await amqp.connect(this.url, this.socketOptions);

    const binder: Binder<AmqpConnection> = Binder.for(connection)
      .bind('error', e => connback.feedError(e))
      .bind('frameError', e => connback.feedError(e))
      .bind('close', e => connback.feedClose(!!e))
      .bind('close', () => binder.unbind());

    Event.once(connback.onclose)(() => binder.unbind());

    return connection;
  };

  close = (client: AmqpConnection): ValueOrPromise<void> => {
    return client.close();
  };
}
