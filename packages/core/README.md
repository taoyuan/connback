# @connback/core

> The core module of connback

## Installation

```shell
npm i @connback/core
```

## Example

An example of TCP connector

```ts
import net from 'net';
import {Binder} from 'event-bind';
import {CancellationToken} from '@jil/cancellation';
import {Connback, ConnbackOpts, Connector} from '@connback/core';

class TcpConnector implements Connector<net.Socket> {
  constructor(public opts: SocketConnectOpts) {}

  // connects to the server and resolves the connection when connected
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

  // close the connection
  close = (client: net.Socket) => client.end();

  // [optional] ping for heartbeat, connback will reconnect if no heartbeat received in `keepalive`
  ping = (client: net.Socket) => client.write('hello');
}

const connback = new Connback<net.Socket>(new TcpConnector({port: 5432}), {
  // all options are optional
  // `60` seconds, set to `0` to disable
  keepalive: 60,
  // `30 * 1000` milliseconds, time to wait before a CONNACK is received
  connectTimeout: 30 * 1000,
  // below options come from @jil/backoff
  strategy: 'fibonacci',
  jitter: 'full',
  initialDelay: 1000,
  maxDelay: 30 * 1000,
  maxNumOfAttempts: Infinity,
  factor: 2,
  delayFirstAttempt: false,
  retry: () => true,
});

connback.onconnect(socket => {
  // listen `error`, `data` and `close` events and feed them to conback
  const binder = Binder.for(socket)
    // feed error
    .bind('error', (error: Error) => connback.feedError(error))
    // feed heartbeat
    .bind('data', () => connback.feedHeartbeat())
    // feed close
    .bind('close', (hasError?: boolean) => connback.feedClose(hasError))
    // unbind all events when close
    .bind('close', () => binder.unbind());
});

connback.onconnect((client: net.Socket) => {
  // Emitted on successful (re)connection
});

connback.onreconnect(() => {
  // Emitted when a reconnect starts
});

connback.onclose(() => {
  // Emitted after a disconnection.
});

connback.onerror(error => {
  // Emitted when an error occurs
});

connback.onoffline(() => {
  // Emitted when the client goes offline
});

connback.onend(() => {
  //Emitted when Connback.end() is called
});

connback.end();
```

## API

- [Connback](#connbacktconstructorconnector-connectort-options-connbackoptions)
  - [Event onconnect](#event-onconnect)
  - [Event onreconnect](#event-onreconnect)
  - [Event onclose](#event-onclose)
  - [Event onoffline](#event-onoffline)
  - [Event onerror](#event-onerror)
  - [Event onend](#event-onend)
- [reconnect(token?: CancellationToken): void](#reconnect)
- [end(force?: boolean): Connback](#end)
- [reschedulePingTimer()](#reschedulePingTimer)
- [feedError(error: Error)](#feedError)
- [feedClose(hasError?: boolean)](#feedClose)
- [feedHeartbeat()](#feedHeartbeat)

---

<a name="connback"></a>

### `Connback<T>.constructor(connector: Connector<T>, options?: ConnbackOptions)`

Create connback and connect to the server with connector provided by given connector handlers.

There is a static creation function:
`Connback<T>.create(connector: Connector<T>, options?: ConnbackOptions): Connback<T>`

Connback using [@jil/event](https://github.com/jiljs/jil/tree/master/packages/event) to provide event functional for
smaller, lighter, more scalable

Arguments:

- `connector` is a collection of handlers to handle connecting, closing and pinging.

  - `connect<T>(connback: Conback<T>, token: CancellationToken): ValueOrPromise<T>` connects to the server and returns a
    connection or promise after connected.
  - `close(client: T, force?: boolean): ValueOrPromise<any>` close the connection
  - `ping?(client: T): any` sending ping data if keepalive is enabled

- `options` is the connback options. some options come from
  [@jil/backoff](https://github.com/jiljs/jil/tree/master/packages/backoff#backoffoptions). Defaults:
  - `keepalive`: `60` seconds, set to `0` to disable
  - `connectTimeout`: `30 * 1000` milliseconds, time to wait before `connect` handler returns
  - `strategy`: `fibonacci` Specify the strategy type or strategy class. Built in strategies are `exponential` and
    `fibonacci`
  - `jitter`: `full` Decides whether a
    [jitters](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) should be applied to the delay.
    Possible values are `full` and `none`
  - `initialDelay`: `1000` The delay, in milliseconds, before executing the function for the first time
  - `maxDelay`: `30 * 1000` The maximum delay, in milliseconds, between two consecutive attempts
  - `maxNumOfAttempts`: `Infinity` The maximum number of times to attempt the function
  - `factor`: `2` The exponential factor. The `initialDelay` is multiplied by the `factor` to increase the delay between
    reattempts
  - `delayFirstAttempt`: `false` Decides whether the `initialDelay` should be applied before the first call. If `false`,
    the first call will occur without a delay

<a name="onconnect"></a>

#### Event `onconnect`

`(client: T) => any`

Emitted on successful (re)connection

<a name="onreconnect"></a>

#### Event `onreconnect`

`() => any`

Emitted when a `reconnect` starts.

<a name="onclose"></a>

#### Event `onclose`

`(hasError: boolean) => any`

Emitted after a disconnection.

<a name="onoffline"></a>

#### Event `onoffline`

`() => any`

Emitted when the client goes offline.

<a name="onerror"></a>

#### Event `onerror`

`(error: Error) => any`

Emitted if errors fed by [feedError](#feedError). The classic errors are connecting issues.

The following TLS errors will be emitted as an `error` event if feed correctly:

- `ECONNREFUSED`
- `ECONNRESET`
- `EADDRINUSE`
- `ENOTFOUND`

<a name="onend"></a>

#### Event `onend`

`() => any`

Emitted when [end()](#end) is called. If a callback was passed to `mqtt.Client#end()`, this event is emitted
once the callback returns.

---

<a name="reconnect"></a>

### `reconnect(token?: CancellationToken): void`

Connect again using the same options as connect(), accepts the following options:

- `token`: A CancellationToken to provide a change to cancel current reconnect processing. If want it to work, you
  should implement cancellation action in `connect` handlers. See the [example](#Example) above.

---

<a name="end"></a>

### `end(force?: boolean): Connback`

Close the client, accepts the following options:

- `force`: passing it to true will close the client right away, without waiting for the in-flight messages to be ack-ed
  in some situations. This parameter is optional.

---

<a name="reschedulePingTimer"></a>

### `reschedulePingTimer()`

Reschedule ping timer. Call it after sending other packets to reduce unnecessary network communication when

---

<a name="feedError"></a>

### `feedError(error: Error)`

Feed error event

---

<a name="feedClose"></a>

### `feedClose(hasError?: boolean)`

Feed close event

---

<a name="feedHeartbeat"></a>

### `feedHeartbeat()`

Feed heartbeat(pong) event
