/* eslint-disable @typescript-eslint/no-explicit-any */

import {isPromise} from 'tily/is/promise';
import {noop} from "tily/function/noop";
import {ValueOrPromise} from '@jil/types';
import {Emitter} from '@jil/event/emitter';
import {retimer, Retimer} from '@jil/retimer';
import {backoff, BackoffOptions} from "@jil/backoff";
import {CancellationToken} from '@jil/cancellation';
import {CancelablePromise, createCancelablePromise} from "@jil/async/cancelable";
import {raceTimeout} from "@jil/async/race";

const debug = require('debug')('connback:connector');

export type ConnectFn<T> = (connector: Connector<T>, token: CancellationToken) => ValueOrPromise<T>;
export type CloseFn<T> = (socket: T, force?: boolean) => ValueOrPromise<any>;
export type PingFn<T> = (socket: T) => any;

export interface ConnectorOpts extends Partial<BackoffOptions> {
  /**
   *  10 seconds, set to 0 to disable
   */
  keepalive: number;
  /**
   * 30 * 1000 milliseconds, time to wait before a CONNACK is received
   */
  connectTimeout: number;

  reschedulePings: boolean;
}

const DEFAULT_CONNBACK_OPTIONS: ConnectorOpts = {
  keepalive: 10,
  connectTimeout: 15 * 1000,
  reschedulePings: true,
  initialDelay: 1000,
  maxDelay: 30 * 1000,
  maxNumOfAttempts: Infinity,
};

export interface ConnectorHandlers<T> {
  connect: ConnectFn<T>;
  close: CloseFn<T>;
  ping?: PingFn<T>;
}

export class Connector<T> {
  readonly options: ConnectorOpts;

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
  protected connectRequest?: CancelablePromise<any>;
  protected reconnectRequest?: CancelablePromise<void>;
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

    this.doConnect().catch(() => this.close());
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

  reconnect(token?: CancellationToken) {
    const run = () => {
      this.ending = false;
      this.ended = false;
      this.deferredReconnect = undefined;
      this.doReconnect(token).catch(e => this.emitError(e));
    };

    if (this.ending && !this.ended) {
      this.deferredReconnect = run;
    } else {
      run();
    }
  }

  end(force?: boolean): this {
    if (this.ending) {
      debug('end :: doing nothing...');
      return this;
    }

    debug('end :: clearReconnect');

    this.cancelReconnect();

    debug('end :: closing');
    this.ending = true;
    this.close(force);
    this.ended = true;
    debug('end :: closed and emit end');
    this._onend.emit(undefined);

    if (this.deferredReconnect) {
      debug('end :: call deferred reconnect');
      this.deferredReconnect();
    }

    return this;
  }

  feedError(error: Error) {
    this.emitError(error);
    this.feedClose();
  }

  // feetConnected() {
  //   this.onConnected();
  // }

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

  protected async doConnect(token?: CancellationToken) {
    if (this.connecting) {
      debug('doConnect :: already connecting, do nothing');
      return;
    }

    this.connecting = true;

    debug('doConnect :: invoke _connect');
    this.connectRequest = createCancelablePromise(token, async child => this._connect(this, child));
    await raceTimeout(this.connectRequest, this.options.connectTimeout, () => {
      this.connectRequest?.cancel();
      this.connectRequest = undefined;
    });

    this.client = await this.connectRequest;
    this.connectRequest = undefined;
    this.onConnected();
  }

  protected onConnected() {
    debug('handleConnected :: connected');
    this.connected = true;
    this.connecting = false;
    this.reconnecting = false;

    // if (this.connectTimer) {
    //   clearTimeout(this.connectTimer);
    //   this.connectTimer = undefined;
    // }

    debug('handleConnected :: setupPingTimer');
    this.setupPingTimer();

    debug('handleConnected :: emit connect');
    this._onconnect.emit(this.client);
  }

  protected async onClose() {
    debug('close :: connecting and connected set to `false`');
    this.connecting = false;
    this.connected = false;

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    if (this.connectRequest) {
      debug('close :: clearing connect timer');
      this.connectRequest.cancel();
      this.connectRequest = undefined;
    }

    debug('close :: clearing ping timer');
    if (this.pingTimer) {
      this.pingTimer.clear();
      this.pingTimer = undefined;
    }

    debug('doClose :: calling setupReconnect');
    this.setupReconnect();
  }

  protected async doReconnect(token?: CancellationToken) {
    debug('doReconnect :: emitting reconnect');
    this._onreconnect.emit();

    if (this.connected) {
      debug('doReconnect :: already connected. closing first.');
      this.end();
    }

    debug('doReconnect :: calling doConnect');
    // eslint-disable-next-line @typescript-eslint/no-shadow
    return token ? this.doConnect(token) : createCancelablePromise(token => this.doConnect(token));
  }

  protected close(force?: boolean) {
    this.connecting = false;

    if (this.client) {
      debug('close :: invoke _close');
      const value = this._close(this.client, force);
      if (isPromise(value)) {
        value.catch(e => this.emitError(e));
      }
    }

    if (!this.ending) {
      debug('close :: not closing. Clearing and resetting reconnect.');
      this.cancelReconnect();
      this.setupReconnect();
    }

    if (this.pingTimer) {
      debug('close :: clearing pingTimer');
      this.pingTimer.clear();
      this.pingTimer = undefined;
    }
  }

  protected setupReconnect() {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    if (this.ending || this.reconnectRequest) {
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      debug(`setupReconnect :: doing nothing...`, {ending: this.ending, requesting: !!this.reconnectRequest});
      return;
    }

    if (!this.reconnecting) {
      debug('setupReconnect :: emit `offline` state');
      this._onoffline.emit();
      debug('setupReconnect :: set `reconnecting` to `true`');
      this.reconnecting = true;
    }

    if (this.ended) {
      debug('setupReconnect :: ended. doing nothing')
      return;
    }

    this.reconnectRequest = backoff(async token => {
      await this.doReconnect(token);
    }, {
      retry: (e, attemptNumber) => {
        this.feedError(e);
        debug(`backoff attempt: #${attemptNumber}`);
        return true;
      }, ...this.options
    });

    this.reconnectRequest
      .catch(() => noop)
      .finally(() => {
        debug('set `reconnectRequest` to undefined');
        this.reconnectRequest = undefined;
      });
  }

  protected cancelReconnect() {
    debug('cancelReconnect :: cancel reconnect request');
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    if (this.reconnectRequest) {
      this.reconnectRequest.cancel();
      this.reconnectRequest = undefined;
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
