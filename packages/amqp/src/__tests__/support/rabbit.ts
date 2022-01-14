import {$} from 'zx';
import {timeout} from '@jil/async/timeout';

export namespace rabbit {
  export const NAME = 'connback.amqp.test';
  export const PORT = 55672;
  export const URL = `amqp://localhost:${PORT}`;

  export async function ps() {
    const id = await $`docker ps --format "{{.ID}}" --filter "name=${NAME}"`;
    return id.stdout.trim();
  }

  export async function up(port = PORT) {
    if (!(await ps())) {
      await $`docker run -d --name ${NAME} -p ${port}:5672 rabbitmq`;
      // wait for startup
      await timeout(15000);
    }
  }

  export async function down() {
    await $`docker rm -f ${NAME}`;
  }

  export async function stopApp() {
    await $`docker exec ${NAME} rabbitmqctl stop_app`;
  }

  export async function startApp() {
    await $`docker exec ${NAME} rabbitmqctl start_app`;
  }
}
