/* eslint-disable @typescript-eslint/no-explicit-any */

import net from 'net';
import {Event} from '@jil/event';
import {fromCallback} from 'tily/promise/fromCallback';
import {noop} from 'tily/function/noop';
import {givenEchoTcpServer, givenSocketConnector, PORT} from './support';
import {delay} from "@jil/async/timeout";

describe('connector', () => {
  let server: net.Server;

  beforeEach(done => {
    server = givenEchoTcpServer();
    server.listen(PORT, done);
  });

  afterEach(() => {
    if (server.listening) {
      server.close();
    }
  });

  describe('closing', () => {
    it('should emit close if connector closes', done => {
      const connector = givenSocketConnector(PORT);

      Event.once(connector.onconnect)(() => {
        connector.client.end();
      });

      Event.once(connector.onclose)(() => {
        connector.end();
        done();
      });
    });

    it('should mark the connector as closed', done => {
      const connector = givenSocketConnector(PORT);

      Event.once(connector.onclose)(() => {
        connector.end();
        if (!connector.connected) {
          done();
        } else {
          done(new Error('Not marked as disconnected'));
        }
      });

      Event.once(connector.onconnect)(conn => fromCallback(cb => conn.end(cb)));
    });

    it('should stop ping timer if connection closes', done => {
      const connector = givenSocketConnector(PORT);

      Event.once(connector.onclose)(() => {
        expect((connector as any).pingTimer).toBeFalsy();
        connector.end(true);
        done();
      });

      Event.once(connector.onconnect)(() => {
        expect((connector as any).pingTimer).toBeTruthy();
        connector.client.end();
      });
    });

    it('should emit close after end called', done => {
      const connector = givenSocketConnector(PORT);

      Event.once(connector.onclose)(() => {
        done();
      });

      Event.once(connector.onconnect)(() => {
        connector.end();
      });
    });

    it('should emit end after end called and connector must be disconnected', done => {
      const connector = givenSocketConnector(PORT);

      Event.once(connector.onend)(() => {
        if (connector.ended) {
          return done();
        }
        done(new Error('connector must be disconnected'));
      });

      Event.once(connector.onconnect)(() => {
        connector.end();
      });
    });

    it('should return `this` if end called twice', done => {
      const connector = givenSocketConnector(PORT);

      Event.once(connector.onconnect)(() => {
        connector.end();
        expect(connector.end()).toBe(connector);
        done();
      });
    });

    it('should emit end only on first connector end', done => {
      const connector = givenSocketConnector(PORT);

      Event.once(connector.onend)(() => {
        const timeout = setTimeout(done.bind(null), 200);
        Event.once(connector.onend)(() => {
          clearTimeout(timeout);
          done(new Error('end was emitted twice'));
        });
        connector.end();
      });

      Event.once(connector.onconnect)(() => connector.end());
    });

    it('should stop ping timer after end called', done => {
      const connector = givenSocketConnector(PORT);

      Event.once(connector.onconnect)(() => {
        expect((connector as any).pingTimer).toBeTruthy();
        connector.end();
        expect((connector as any).pingTimer).toBeFalsy();
        done();
      });
    });

    it('should be able to end even on a failed connection', done => {
      const connector = givenSocketConnector({host: 'this_hostname_should_not_exist'});

      const timeout = setTimeout(() => {
        done(new Error('Failed to end a disconnected connector'));
      }, 500);

      setTimeout(() => {
        connector.end();
        clearTimeout(timeout);
        done();
      }, 200);
    });

    it('should emit end even on a failed connection', done => {
      const connector = givenSocketConnector({host: 'this_hostname_should_not_exist'});

      const timeout = setTimeout(() => {
        done(new Error('Disconnected connector has failed to emit end'));
      }, 500);

      Event.once(connector.onend)(() => {
        clearTimeout(timeout);
        done();
      });

      // after 200ms manually invoke connector.end
      setTimeout(() => {
        const boundEnd = connector.end.bind(connector);
        boundEnd();
      }, 200);
    });
  });

  describe('connecting', () => {
    it('should connect to the server', async () => {
      const connector = givenSocketConnector();

      expect(connector.connecting).toBe(true);
      expect(connector.connected).toBe(false);

      await Promise.all([
        fromCallback(cb => server.once('connection', () => cb())),
        Event.toPromise(connector.onconnect),
      ]);

      expect(connector.connecting).toBe(false);
      expect(connector.connected).toBe(true);
      connector.end();
    });

    it('should emit connect', done => {
      const connector = givenSocketConnector();
      Event.once(connector.onconnect)(() => {
        connector.end(true);
      });
      Event.once(connector.onclose)(done);
    });

    it('should emit error event if the socket refuses the connection', done => {
      // fake a port
      const connector = givenSocketConnector({port: 54321});

      connector.onerror(function (e) {
        expect((e as any).code).toEqual('ECONNREFUSED');
        connector.end();
        done();
      });
    });
  });

  describe('handling offline states', () => {
    it('should emit offline event once when the client transitions from connected states to disconnected ones', done => {
      const connector = givenSocketConnector();

      connector.onconnect(() => {
        connector.client.end();
      });

      connector.onoffline(() => {
        connector.end(true);
        done();
      });
    });

    it('should emit offline event once when the client (at first) can NOT connect to servers', done => {
      // fake a port
      const connector = givenSocketConnector({port: 4557});

      connector.onoffline(() => {
        connector.end(true);
        done();
      });
    });
  });

  describe('pinging', () => {
    it('should set a ping timer', done => {
      const connector = givenSocketConnector({keepalive: 3});
      Event.once(connector.onconnect)(() => {
        expect((connector as any).pingTimer).toBeTruthy();
        connector.end(true);
        done();
      });
    });

    it('should not set a ping timer keepalive=0', done => {
      const connector = givenSocketConnector({keepalive: 0});
      connector.onconnect(() => {
        expect((connector as any).pingTimer).toBeFalsy();
        connector.end(true);
        done();
      });
    });

    it('should reconnect if nothing is sent', done => {
      const connector = givenSocketConnector({keepalive: 1, initialDelay: 50, maxDelay: 100});

      // Fake no heartbeat being sent by stubbing the feedHeartbeat function
      connector.feedHeartbeat = noop;

      Event.once(connector.onconnect)(() => {
        Event.once(connector.onconnect)(() => {
          connector.end(true);
          done();
        });
      });
    });

    it('should not reconnect if heartbeat is successful', done => {
      const connector = givenSocketConnector({keepalive: 100});
      const unsub = Event.once(connector.onclose)(() => {
        done.fail('Client closed connection');
      });

      setTimeout(() => {
        unsub();
        connector.end();
        done();
      }, 1000);
    });

    it('should defer the next ping when rescheduling PingTimer', async () => {
      const checkPing = jest.fn();
      const connector = givenSocketConnector({keepalive: 1});

      (connector as any).checkPing = checkPing;

      await Event.toPromise(connector.onconnect);
      connector.reschedulePingTimer();

      await delay(75);
      expect(checkPing).not.toHaveBeenCalled();

      connector.reschedulePingTimer();
      await delay(75);
      expect(checkPing).not.toHaveBeenCalled();

      connector.reschedulePingTimer();
      await delay(75);
      expect(checkPing).not.toHaveBeenCalled();

      connector.end();
    });
  });
});
