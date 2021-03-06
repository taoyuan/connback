/* eslint-disable @typescript-eslint/no-explicit-any */

import {isPromise} from 'tily/is/promise';
import {noop} from 'tily/function/noop';
import {MarkRequired} from "ts-essentials";
import {ValueOrPromise} from '@jil/common';
import {Emitter} from '@jil/common/event/emitter';
import {retimer, Retimer} from '@jil/retimer';
import {backoff, BackoffOptions} from '@jil/backoff';
import {CancellationToken} from '@jil/common/cancellation';
import {CancelablePromise, createCancelablePromise} from '@jil/common/async/cancelable';
import {raceTimeout} from '@jil/common/async/race';

const debug = require('debug')('connback:core');

export interface Connector<T> {
  /**
   * connects to the server and returns a connection or promise after connected.
   *
   * @param connback
   * @param token
   */
  connect(connback: Connback<T>, token: CancellationToken): ValueOrPromise<T>;

  /**
   * close the connection
   *
   * @param client
   * @param force
   */
  close(client: T, force?: boolean): ValueOrPromise<any>;

  /**
   * sending ping data if keepalive is enabled
   * @param client
   */
  ping?(client: T): any;
}

export interface ConnbackOpts extends Omit<BackoffOptions, 'retry'> {
  /**
   *  10 seconds, set to 0 to disable
   */
  keepalive?: number;
  /**
   * 30 * 1000 milliseconds, time to wait before a CONNACK is received
   */
  connectTimeout?: number;
}

type ConnbackConfig = MarkRequired<ConnbackOpts,
  | 'connectTimeout'
  | 'keepalive'>

const DEFAULT_CONNBACK_OPTIONS: ConnbackConfig = {
  keepalive: 60,
  connectTimeout: 30 * 1000,
  strategy: 'fibonacci',
  jitter: 'full',
  initialDelay: 1000,
  maxDelay: 30 * 1000,
  maxNumOfAttempts: Infinity,
};

export class Connback<T> {
  readonly options: ConnbackConfig;

  client: T;

  protected _onerror = new Emitter<Error>();
  readonly onerror = this._onerror.event;

  protected _onconnect = new Emitter<T>();
  readonly onconnect = this._onconnect.event;

  protected _onclose = new Emitter<boolean | undefined>();
  readonly onclose = this._onclose.event;

  protected _onreconnect = new Emitter<void>();
  readonly onreconnect = this._onreconnect.event;

  protected _onend = new Emitter<void>();
  readonly onend = this._onend.event;

  protected _onoffline = new Emitter<void>();
  readonly onoffline = this._onoffline.event;

  protected alive = false;
  protected connectRequest?: CancelablePromise<any>;
  protected reconnectRequest?: CancelablePromise<void>;
  protected pingTimer?: Retimer;
  protected deferredReconnect?: () => void;

  constructor(protected connector: Connector<T>, options?: ConnbackOpts) {
    this.options = {...DEFAULT_CONNBACK_OPTIONS, ...options} as ConnbackConfig;
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

  static create<T>(connector: Connector<T>, options?: ConnbackOpts) {
    return new Connback(connector, options);
  }

  /**
   * Connect again using the same options as connect()
   *
   * @param token
   */
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

  /**
   * Close the client
   *
   * @param force passing it to true will close the client right away, without
   *   waiting for the in-flight messages to be ack-ed in some situations.
   *   This parameter is optional.
   */
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
    this._onend.emit();

    if (this.deferredReconnect) {
      debug('end :: call deferred reconnect');
      this.deferredReconnect();
    }

    return this;
  }

  /**
   * Reschedule ping timer. Call it after sending other packets to reduce unnecessary network communication when
   */
  reschedulePingTimer() {
    if (this.pingTimer && this.options.keepalive) {
      this.pingTimer.reschedule();
    }
  }

  /**
   * Feed error event
   *
   * @param error
   */
  feedError(error: Error) {
    this.emitError(error);
    this.feedClose();
  }

  /**
   * Feed close event
   *
   * @param hasError true if the connection had a transmission error.
   *
   * @example
   *  ...
   *  socket.on('close', hasError => connback.feedClose(hasError));
   *  ...
   */
  feedClose(hasError?: boolean) {
    this._onclose.emit(hasError);
  }

  /**
   * Feed heartbeat(pong) event
   */
  feedHeartbeat() {
    this.alive = true;
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

    debug('doConnect :: invoke connector.connect');
    this.connectRequest = createCancelablePromise(token, async child => this.connector.connect(this, child));
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
      debug('close :: invoke connector.close');
      const value = this.connector.close(this.client, force);
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
      debug('setupReconnect :: ended. doing nothing');
      return;
    }

    this.reconnectRequest = backoff(
      async token => {
        await this.doReconnect(token);
      },
      {
        retry: (e, attemptNumber) => {
          this.feedError(e);
          debug(`backoff attempt: #${attemptNumber}`);
          return true;
        },
        ...this.options,
      },
    );

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
      debug('checkPing :: invoke connector.ping');
      this.connector.ping?.(this.client);
    } else {
      // do a forced close since connection will be in bad shape
      debug('checkPing :: calling close with force true');
      this.close(true);
    }
  }
}
