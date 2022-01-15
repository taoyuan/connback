/* eslint-disable @typescript-eslint/no-explicit-any */

import net from 'net';
import {fromCallback} from 'tily/promise/fromCallback';
import {noop} from 'tily/function/noop';
import {Event} from '@jil/common/event';
import {delay} from '@jil/common/async/timeout';
import {givenEchoTcpServer, givenTcpConnback, PORT} from './support';

describe('connback', () => {
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
    it('should emit close if connback closes', done => {
      const connback = givenTcpConnback(PORT);

      Event.once(connback.onconnect)(() => {
        connback.client.end();
      });

      Event.once(connback.onclose)(() => {
        connback.end();
        done();
      });
    });

    it('should mark the connback as closed', done => {
      const connback = givenTcpConnback(PORT);

      Event.once(connback.onclose)(() => {
        connback.end();
        if (!connback.connected) {
          done();
        } else {
          done(new Error('Not marked as disconnected'));
        }
      });

      Event.once(connback.onconnect)(conn => fromCallback(cb => conn.end(cb)));
    });

    it('should stop ping timer if connection closes', done => {
      const connback = givenTcpConnback(PORT);

      Event.once(connback.onclose)(() => {
        expect((connback as any).pingTimer).toBeFalsy();
        connback.end(true);
        done();
      });

      Event.once(connback.onconnect)(() => {
        expect((connback as any).pingTimer).toBeTruthy();
        connback.client.end();
      });
    });

    it('should emit close after end called', done => {
      const connback = givenTcpConnback(PORT);

      Event.once(connback.onclose)(() => {
        done();
      });

      Event.once(connback.onconnect)(() => {
        connback.end();
      });
    });

    it('should emit end after end called and connback must be disconnected', done => {
      const connback = givenTcpConnback(PORT);

      Event.once(connback.onend)(() => {
        if (connback.ended) {
          return done();
        }
        done(new Error('connback must be disconnected'));
      });

      Event.once(connback.onconnect)(() => {
        connback.end();
      });
    });

    it('should return `this` if end called twice', done => {
      const connback = givenTcpConnback(PORT);

      Event.once(connback.onconnect)(() => {
        connback.end();
        expect(connback.end()).toBe(connback);
        done();
      });
    });

    it('should emit end only on first connback end', done => {
      const connback = givenTcpConnback(PORT);

      Event.once(connback.onend)(() => {
        const timeout = setTimeout(done.bind(null), 200);
        Event.once(connback.onend)(() => {
          clearTimeout(timeout);
          done(new Error('end was emitted twice'));
        });
        connback.end();
      });

      Event.once(connback.onconnect)(() => connback.end());
    });

    it('should stop ping timer after end called', done => {
      const connback = givenTcpConnback(PORT);

      Event.once(connback.onconnect)(() => {
        expect((connback as any).pingTimer).toBeTruthy();
        connback.end();
        expect((connback as any).pingTimer).toBeFalsy();
        done();
      });
    });

    it('should be able to end even on a failed connection', done => {
      const connback = givenTcpConnback({host: 'this_hostname_should_not_exist'});

      const timeout = setTimeout(() => {
        done(new Error('Failed to end a disconnected connback'));
      }, 500);

      setTimeout(() => {
        connback.end();
        clearTimeout(timeout);
        done();
      }, 200);
    });

    it('should emit end even on a failed connection', done => {
      const connback = givenTcpConnback({host: 'this_hostname_should_not_exist'});

      const timeout = setTimeout(() => {
        done(new Error('Disconnected connback has failed to emit end'));
      }, 500);

      Event.once(connback.onend)(() => {
        clearTimeout(timeout);
        done();
      });

      // after 200ms manually invoke connback.end
      setTimeout(() => {
        const boundEnd = connback.end.bind(connback);
        boundEnd();
      }, 200);
    });
  });

  describe('connecting', () => {
    it('should connect to the server', async () => {
      const connback = givenTcpConnback();

      expect(connback.connecting).toBe(true);
      expect(connback.connected).toBe(false);

      await Promise.all([
        fromCallback(cb => server.once('connection', () => cb())),
        Event.toPromise(connback.onconnect),
      ]);

      expect(connback.connecting).toBe(false);
      expect(connback.connected).toBe(true);
      connback.end();
    });

    it('should emit connect', done => {
      const connback = givenTcpConnback();
      Event.once(connback.onconnect)(() => {
        connback.end(true);
      });
      Event.once(connback.onclose)(done);
    });

    it('should emit error event if the socket refuses the connection', done => {
      // fake a port
      const connback = givenTcpConnback({port: 54321});

      connback.onerror(function (e) {
        expect((e as any).code).toEqual('ECONNREFUSED');
        connback.end();
        done();
      });
    });
  });

  describe('handling offline states', () => {
    it('should emit offline event once when the client transitions from connected states to disconnected ones', done => {
      const connback = givenTcpConnback();

      connback.onconnect(() => {
        connback.client.end();
      });

      connback.onoffline(() => {
        connback.end(true);
        done();
      });
    });

    it('should emit offline event once when the client (at first) can NOT connect to servers', done => {
      // fake a port
      const connback = givenTcpConnback({port: 4557});

      connback.onoffline(() => {
        connback.end(true);
        done();
      });
    });
  });

  describe('pinging', () => {
    it('should set a ping timer', done => {
      const connback = givenTcpConnback({keepalive: 3});
      Event.once(connback.onconnect)(() => {
        expect((connback as any).pingTimer).toBeTruthy();
        connback.end(true);
        done();
      });
    });

    it('should not set a ping timer keepalive=0', done => {
      const connback = givenTcpConnback({keepalive: 0});
      connback.onconnect(() => {
        expect((connback as any).pingTimer).toBeFalsy();
        connback.end(true);
        done();
      });
    });

    it('should reconnect if nothing is sent', done => {
      const connback = givenTcpConnback({keepalive: 1, initialDelay: 50, maxDelay: 100});

      // Fake no heartbeat being sent by stubbing the feedHeartbeat function
      connback.feedHeartbeat = noop;

      Event.once(connback.onconnect)(() => {
        Event.once(connback.onconnect)(() => {
          connback.end(true);
          done();
        });
      });
    });

    it('should not reconnect if heartbeat is successful', done => {
      const connback = givenTcpConnback({keepalive: 100});
      const unsub = Event.once(connback.onclose)(() => {
        done.fail('Client closed connection');
      });

      setTimeout(() => {
        unsub();
        connback.end();
        done();
      }, 1000);
    });

    it('should defer the next ping when rescheduling PingTimer', async () => {
      const checkPing = jest.fn();
      const connback = givenTcpConnback({keepalive: 1});

      (connback as any).checkPing = checkPing;

      await Event.toPromise(connback.onconnect);
      connback.reschedulePingTimer();

      await delay(75);
      expect(checkPing).not.toHaveBeenCalled();

      connback.reschedulePingTimer();
      await delay(75);
      expect(checkPing).not.toHaveBeenCalled();

      connback.reschedulePingTimer();
      await delay(75);
      expect(checkPing).not.toHaveBeenCalled();

      connback.end();
    });
  });
});
