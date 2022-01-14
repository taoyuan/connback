import {Channel, ConfirmChannel, Connection, Options} from 'amqplib';

export type AmqpConnectOpts = Options.Connect;
export type AmqpConnection = Connection;
export type AmqpChannel = Channel;
export type AmqpConfirmConnection = ConfirmChannel;
