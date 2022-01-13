/* eslint-disable @typescript-eslint/no-explicit-any */

import {ValueOrPromise} from '@jil/types';
import {Event} from '@jil/event';
import {Emitter} from '@jil/event/emitter';
import {retimer, Retimer} from '@jil/retimer/dist/retimer';
import {isPromise} from 'tily/is/promise';

const debug = require('debug')('connback');

export type ConnectFn<T> = (connector: Connector<T>) => T;
export type CloseFn<T> = (socket: T, force?: boolean) => ValueOrPromise<any>;
export type PingFn<T> = (socket: T) => any;

export interface ConnectorOpts {
  /**
   *  10 seconds, set to 0 to disable
   */
  keepalive?: number;
  /**
   * 1000 milliseconds, interval between two reconnections
   */
  reconnectPeriod?: number;
  /**
   * 30 * 1000 milliseconds, time to wait before a CONNACK is received
   */
  connectTimeout?: number;

  reschedulePings?: boolean;
}

const DEFAULT_CONNBACK_OPTIONS: Required<ConnectorOpts> = {
  keepalive: 10,
  reconnectPeriod: 1000,
  connectTimeout: 15 * 1000,
  reschedulePings: true,
};

export interface ConnectorHandlers<T> {
  connect: ConnectFn<T>;
  close: CloseFn<T>;
  ping?: PingFn<T>;
}

export class Connector<T> {
  readonly options: Required<ConnectorOpts>;

  client: T;

  protected _onerror = new Emitter<Error>();
  readonly onerror = this._onerror.event;

  protected _onconnect = new Emitter<T>();
  readonly onconnect = this._onconnect.event;

  protected _onclose = new Emitter<boolean | undefined>();
  readonly onclose = this._onclose.event;

  protected _onreconnect = new Emitter<void>();
  readonly onreconnect = this._onreconnect.event;

  protected _onend = new Emitter<boolean | undefined>();
  readonly onend = this._onend.event;

  protected _onoffline = new Emitter<void>();
  readonly onoffline = this._onoffline.event;

  protected alive = false;
  protected connectTimer?: NodeJS.Timer;
  protected reconnectTimer?: Retimer;
  protected pingTimer?: Retimer;
  protected deferredReconnect?: () => void;

  private readonly _connect: ConnectFn<T>;
  private readonly _close: CloseFn<T>;
  private readonly _ping?: PingFn<T>;

  constructor(handlers: ConnectorHandlers<T>, options?: ConnectorOpts) {
    this._connect = handlers.connect;
    this._close = handlers.close;
    this._ping = handlers.ping;

    this.options = {...DEFAULT_CONNBACK_OPTIONS, ...options};

    this.onclose(() => this.onClose());

    this.doConnect();
  }

  protected _reconnecting: boolean;

  get reconnecting(): boolean {
    return this._reconnecting;
  }

  protected set reconnecting(value: boolean) {
    this._reconnecting = value;
  }

  protected _ending: boolean;

  get ending(): boolean {
    return this._ending;
  }

  protected set ending(value: boolean) {
    this._ending = value;
  }

  protected _ended: boolean;

  get ended(): boolean {
    return this._ended;
  }

  protected set ended(value: boolean) {
    this._ended = value;
  }

  protected _connecting = false;

  get connecting(): boolean {
    return this._connecting;
  }

  set connecting(value: boolean) {
    this._connecting = value;
  }

  protected _connected = false;

  get connected(): boolean {
    return this._connected;
  }

  set connected(value: boolean) {
    this._connected = value;
  }

  async reconnect() {
    const perform = () => {
      this.ending = false;
      this.ended = false;
      this.deferredReconnect = undefined;
      this.doReconnect();
    };

    if (this.ending && !this.ended) {
      this.deferredReconnect = perform;
    } else {
      perform();
    }
  }

  end(force?: boolean): this {
    if (this.ending) {
      debug('Close :: doing nothing...');
      return this;
    }

    debug('Close :: clearReconnect');

    this.clearReconnect();

    debug('Close :: closing');
    this.ending = true;
    this.close(force);
    this.ended = true;
    debug('Close :: closed');
    debug('Close :: emit close');
    this._onend.emit(undefined);

    if (this.deferredReconnect) {
      debug('Close :: call deferred reconnect');
      this.deferredReconnect();
    }

    return this;
  }

  async endAsync(force?: boolean): Promise<this> {
    if (this.ended) {
      return this;
    }

    this.end(force);

    return Event.toPromise(this.onclose).then(() => this);
  }

  feedError(error: Error) {
    this.emitError(error);
    this.feedClose();
  }

  feetConnected() {
    this.onConnected();
  }

  /**
   * Call this if disconnected.
   *
   * @param hasError true if the connection had a transmission error.
   *
   * @example
   *  ...
   *  socket.on('close', hasError => connectivity.feedDisconnect(hasError));
   *  ...
   */
  feedClose(hasError?: boolean) {
    this._onclose.emit(hasError);
  }

  feedHeartbeat() {
    this.alive = true;
  }

  reschedulePingTimer() {
    if (this.pingTimer && this.options.keepalive && this.options.reschedulePings) {
      this.pingTimer.reschedule();
    }
  }

  protected emitError(error: Error) {
    this._onerror.emit(error);
  }

  protected doConnect() {
    if (this.connecting) {
      debug('doConnect :: already connecting, do nothing');
      return;
    }

    this.connecting = true;

    debug('doConnect :: calling method to clear reconnect');
    this.clearReconnect();

    debug('doConnect :: invoke external connect');
    this.client = this._connect(this);

    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }

    if (this.options.connectTimeout) {
      this.connectTimer = setTimeout(() => {
        debug('!!connectTimeout hit!! Calling close with force `true`');
        this.close();
      }, this.options.connectTimeout);
    }
  }

  protected onConnected() {
    debug('handleConnected :: connected');
    this.connected = true;
    this.connecting = false;
    this.reconnecting = false;

    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }

    debug('handleConnected :: setupPingTimer');
    this.setupPingTimer();

    debug('handleConnected :: emit connect');
    this._onconnect.emit(this.client);
  }

  protected async onClose() {
    debug('close :: connecting and connected set to `false`');
    this.connecting = false;
    this.connected = false;

    if (this.connectTimer) {
      debug('close :: clearing connect timer');
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }

    debug('close :: clearing ping timer');
    if (this.pingTimer) {
      this.pingTimer.clear();
      this.pingTimer = undefined;
    }

    debug('doClose :: calling setupReconnect');
    this.setupReconnect();
  }

  protected doReconnect() {
    debug('doReconnect :: emitting reconnect');
    this._onreconnect.emit();

    if (this.connected) {
      debug('doReconnect :: already connected. closing first.');
      this.end();
    }

    debug('doReconnect :: calling doConnect');
    this.doConnect();
  }

  protected close(force?: boolean) {
    this.connecting = false;

    if (this.client) {
      debug('Close :: invoke external close');
      const value = this._close(this.client, force);
      if (isPromise(value)) {
        value.catch(e => this.emitError(e));
      }
    }

    if (!this.ending) {
      debug('Close :: not closing. Clearing and resetting reconnect.');
      this.clearReconnect();
      this.setupReconnect();
    }

    if (this.pingTimer) {
      debug('Close :: clearing pingTimer');
      this.pingTimer.clear();
      this.pingTimer = undefined;
    }
  }

  protected setupReconnect() {
    if (!this.ending && !this.reconnectTimer && this.options.reconnectPeriod > 0) {
      if (!this.reconnecting) {
        debug('setupReconnect :: emit `offline` state');
        this._onoffline.emit();
        debug('setupReconnect :: set `reconnecting` to `true`');
        this.reconnecting = true;
      }
      debug('setupReconnect :: setting reconnectTimer for %d ms', this.options.reconnectPeriod);
      this.reconnectTimer = retimer(() => {
        debug('reconnectTimer :: reconnect triggered!');
        this.doReconnect();
      }, this.options.reconnectPeriod);
    } else {
      debug('setupReconnect :: doing nothing...');
    }
  }

  protected clearReconnect() {
    debug('clearReconnect :: clearing reconnect timer');
    if (this.reconnectTimer) {
      this.reconnectTimer.clear();
      this.reconnectTimer = undefined;
    }
  }

  protected setupPingTimer() {
    debug('setupPingTimer :: keepalive %d (seconds)', this.options.keepalive);
    if (!this.pingTimer && this.options.keepalive) {
      this.alive = true;
      this.pingTimer = retimer(() => {
        this.checkPing();
        this.pingTimer?.reschedule();
      }, this.options.keepalive * 1000);
    }
  }

  protected checkPing() {
    debug('checkPing :: checking ping...');
    if (this.alive) {
      debug('checkPing :: clearing flag and request ping');
      this.alive = false;
      this._ping?.(this.client);
    } else {
      // do a forced close since connection will be in bad shape
      debug('checkPing :: calling close with force true');
      this.close(true);
    }
  }
}
