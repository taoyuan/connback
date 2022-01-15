import {Event} from '@jil/common/event';
import {rabbit} from './support/rabbit';
import {AmqpConnback} from '../amqp.connback';

describe('amqp.connback', function () {
  beforeAll(async () => {
    await rabbit.up();
  }, 20000);

  afterAll(async () => {
    // await rabbit.down();
  });

  it('should connect and close', async () => {
    const connback = new AmqpConnback(rabbit.URL);
    await Event.toPromise(connback.onconnect);
    expect(connback.connected).toBe(true);
    connback.end();
    await Event.toPromise(connback.onclose);
    expect(connback.connected).toBe(false);
  });
});
