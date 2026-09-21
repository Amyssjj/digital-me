/** Bind the request listener to a TCP port (excluded from coverage: listen() only). */

import { createServer, type Server } from "node:http";
import { createRequestListener } from "./http-app.js";
import type { BrainHostRuntime } from "./runtime.js";

export type StartOptions = {
  readonly runtime: BrainHostRuntime;
  readonly token: string;
  readonly host: string;
  readonly port: number;
  readonly log: (line: string) => void;
};

export function startServer(opts: StartOptions): Promise<Server> {
  const listener = createRequestListener({
    token: opts.token,
    invoke: (tool, args) => opts.runtime.invoke(tool, args),
    health: () => opts.runtime.health(),
    log: opts.log,
  });
  const server = createServer((req, res) => {
    void listener(req, res);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve(server));
  });
}
