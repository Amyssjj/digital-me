/** Bind the request listener to a TCP port (excluded from coverage: listen() only). */

import { createServer, type Server } from "node:http";
import { createRequestListener } from "./http-app.js";
import { VERSION, type BrainHostRuntime } from "./runtime.js";

export type StartOptions = {
  readonly runtime: Pick<BrainHostRuntime, "invoke" | "health">;
  readonly token: string;
  readonly host: string;
  readonly port: number;
  readonly log: (line: string) => void;
};

export function startServer(opts: StartOptions): Promise<Server> {
  const listener = createRequestListener({
    token: opts.token,
    version: VERSION,
    invoke: (tool, args) => opts.runtime.invoke(tool, args),
    health: () => opts.runtime.health(),
    log: opts.log,
  });
  const server = createServer((req, res) => {
    // The listener never rejects (it turns every failure into a response),
    // so a client abort cannot become an unhandled rejection here.
    void listener(req, res);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve(server));
  });
}
