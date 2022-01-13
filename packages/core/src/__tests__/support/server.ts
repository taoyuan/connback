import net from 'net';

export class EchoTcpServer extends net.Server {
  clients: net.Socket[] = [];

  constructor() {
    super();

    this.on('connection', socket => {
      this.clients.push(socket);
      socket.once('close', () => this.clients.splice(this.clients.indexOf(socket), 1));

      socket.on('data', function (data) {
        socket.write(data.toString());
      });
    });
  }
}
