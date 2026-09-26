import http from 'node:http';
import { assertRuntimeConfig, config } from './config.mjs';
import { handleRequest } from './handler.mjs';
import { startPersonalWatcher } from './personal-watcher.mjs';

assertRuntimeConfig();

const server = http.createServer(handleRequest);

server.listen(config.port, () => {
  console.log(`[NexMeta] listening on :${config.port}`);
  startPersonalWatcher();
});
