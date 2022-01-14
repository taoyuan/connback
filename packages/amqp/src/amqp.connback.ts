import {SocketConnectOpts} from 'net';
import {Connback, ConnbackOpts} from '@connback/core';
import {AmqpConnection, AmqpConnectOpts} from './types';
import {AmqpConnector} from './amqp.connector';

export type AmqpConnbackOpts = ConnbackOpts & SocketConnectOpts;

export class AmqpConnback extends Connback<AmqpConnection> {
  constructor(url: string | AmqpConnectOpts, options?: AmqpConnbackOpts) {
    super(new AmqpConnector(url, options), options);
  }
}
